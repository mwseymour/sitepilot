import type { ChatThreadId, SiteId } from "@sitepilot/domain";
import {
  createAnthropicChatClient,
  createOpenAiChatClient,
  type ChatMessage,
  type ChatModelClient
} from "@sitepilot/provider-adapters";
import { extractJsonObject } from "@sitepilot/services";
import { normalizeMcpToolResult } from "@sitepilot/mcp-client";

import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import {
  buildExternalPageReply,
  buildExternalPageRequestPrompt,
  buildExternalPageRequestTitle,
  fetchExternalPageText,
  parseExternalResearchIntent
} from "./external-page-research-service.js";
import { loadPlannerPreferences } from "./planner-preferences-service.js";
import { createMcpClientForSite } from "./site-mcp-client.js";

type ChosenProvider =
  | { kind: "openai"; client: ChatModelClient; model: string }
  | { kind: "anthropic"; client: ChatModelClient; model: string }
  | { kind: "stub" };

type ResponseKind =
  | "list"
  | "count"
  | "id"
  | "content"
  | "url"
  | "created"
  | "modified";

type ConversationToolName = "sitepilot-find-posts" | "sitepilot-get-post";

type ConversationPlan =
  | { mode: "reply"; reply: string }
  | {
      mode: "external_page";
      url: string;
      createRequest: boolean;
    }
  | {
      mode: "tool";
      toolName: ConversationToolName;
      responseKind: ResponseKind;
      arguments: Record<string, unknown>;
    }
  | {
      mode: "multi_count";
      postTypes: Array<"post" | "page">;
    };

function stripPostMarkup(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chooseConversationProvider(input: {
  preferredProvider: "auto" | "openai" | "anthropic";
  openaiKey?: string;
  openaiModel: string;
  anthropicKey?: string;
  anthropicModel: string;
}): ChosenProvider {
  const openai =
    input.openaiKey !== undefined
      ? {
          kind: "openai" as const,
          client: createOpenAiChatClient(input.openaiKey),
          model: input.openaiModel
        }
      : null;
  const anthropic =
    input.anthropicKey !== undefined
      ? {
          kind: "anthropic" as const,
          client: createAnthropicChatClient(input.anthropicKey),
          model: input.anthropicModel
        }
      : null;

  if (input.preferredProvider === "openai") {
    return openai ?? anthropic ?? { kind: "stub" };
  }
  if (input.preferredProvider === "anthropic") {
    return anthropic ?? openai ?? { kind: "stub" };
  }
  return openai ?? anthropic ?? { kind: "stub" };
}

function looksLikeWriteRequest(text: string): boolean {
  if (
    /\b(when\s+was|created\s+at|created\s+on|get\s+the\s+text|get\s+text|show\s+text|what\s+is\s+the\s+url|permalink|link)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return /\b(create|update|edit|change|delete|remove|publish|upload|replace|execute|run|approve)\b/i.test(
    text
  );
}

function parseCount(text: string): number | null {
  const match = text.match(
    /\b(?:last|latest|newest|oldest|first|show|fetch|get|list|find|give)(?:\s+me)?\s+(\d{1,2})\b/i
  );
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractPostId(text: string): number | null {
  const urlMatch = text.match(/[?&]post=(\d+)/i);
  if (urlMatch?.[1]) {
    return Number.parseInt(urlMatch[1], 10);
  }
  const idMatch = text.match(/\bpost\s+(\d+)\b/i) ?? text.match(/\bpage\s+(\d+)\b/i);
  if (idMatch?.[1]) {
    return Number.parseInt(idMatch[1], 10);
  }
  return null;
}

function detectPostType(text: string): "post" | "page" | null {
  if (/\bpages\b|\bpage\b/i.test(text) && !/\bposts and pages\b/i.test(text)) {
    return "page";
  }
  if (/\bposts\b|\bpost\b/i.test(text)) {
    return "post";
  }
  return null;
}

function extractCategory(text: string): string | null {
  const match =
    text.match(/\bcategory\s+['"]?([a-z0-9- ]+)['"]?/i) ??
    text.match(/\bposts?\s+(?:in|from)\s+['"]?([a-z0-9- ]+)['"]?\s+category\b/i);
  return match?.[1]
    ? match[1].trim().toLowerCase().replace(/\s+/g, "-")
    : null;
}

function extractQuotedOrTitledName(text: string): string | null {
  const titledMatch = text.match(
    /(?:post|page)\s+titled\s+['"]?([^'"\n]+?)['"]?(?:$|[?.!])/i
  );
  if (titledMatch?.[1]) {
    return titledMatch[1].trim();
  }
  const quotedMatch = text.match(/['"]([^'"\n]+)['"]/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  return null;
}

function buildGetPostArguments(text: string): Record<string, unknown> | null {
  const postId = extractPostId(text);
  const postType = detectPostType(text);
  const title = extractQuotedOrTitledName(text);

  if (postId !== null) {
    return {
      post_id: postId,
      ...(postType !== null ? { post_type: postType } : {})
    };
  }

  if (title !== null) {
    return {
      title,
      post_type: postType ?? "post",
      status: "any"
    };
  }

  return null;
}

function detectOrdering(
  text: string
): { orderby: "date" | "modified" | "rand"; order: "ASC" | "DESC" } | null {
  if (/\brandom(ly)?\b/i.test(text)) {
    return { orderby: "rand", order: "DESC" };
  }
  if (/\b(oldest|first)\b/i.test(text)) {
    return { orderby: "date", order: "ASC" };
  }
  if (/\b(last|latest|newest|most recent|recent(ly)?)\b.*\b(updated|modified|edited)\b/i.test(text)) {
    return { orderby: "modified", order: "DESC" };
  }
  if (/\b(last|latest|newest|most recent|recent(ly)?)\b/i.test(text)) {
    return { orderby: "date", order: "DESC" };
  }
  return null;
}

function asksForSingleLatest(text: string): boolean {
  return (
    /\b(the\s+)?(last|latest|newest|most recent|oldest|first)\s+(post|page)\b/i.test(text) &&
    parseCount(text) === null
  );
}

function detectResponseKind(text: string): Exclude<ResponseKind, "list" | "count"> | null {
  if (/\b(id|ids)\b/i.test(text)) {
    return "id";
  }
  if (/\b(url|permalink|link)\b/i.test(text)) {
    return "url";
  }
  if (/\b(when|what time).*\b(created|published)\b|\bcreated at\b|\bcreated on\b/i.test(text)) {
    return "created";
  }
  if (/\bmodified\b|\bupdated\b/i.test(text)) {
    return "modified";
  }
  if (/\b(text|content|body)\b/i.test(text)) {
    return "content";
  }
  return null;
}

function fallbackConversationPlan(text: string): ConversationPlan {
  const normalized = text.trim();
  const lowered = normalized.toLowerCase();
  const externalResearch = parseExternalResearchIntent(normalized);
  if (externalResearch) {
    return {
      mode: "external_page",
      url: externalResearch.url,
      createRequest: externalResearch.shouldCreateRequest
    };
  }

  if (looksLikeWriteRequest(lowered)) {
    return {
      mode: "reply",
      reply:
        "Conversations are read-only. Use the Requests window if you want SitePilot to make or execute changes."
    };
  }

  if (/\bhow many\b/i.test(normalized) && /\bposts?\s+and\s+pages?\b/i.test(normalized)) {
    return {
      mode: "multi_count",
      postTypes: ["post", "page"]
    };
  }

  if (/\bhow many\b/i.test(normalized) && /\bpages?\b/i.test(normalized)) {
    return {
      mode: "tool",
      toolName: "sitepilot-find-posts",
      responseKind: "count",
      arguments: {
        post_type: "page",
        status: "any",
        limit: 1
      }
    };
  }

  if (/\bhow many\b/i.test(normalized) && /\bposts?\b/i.test(normalized)) {
    return {
      mode: "tool",
      toolName: "sitepilot-find-posts",
      responseKind: "count",
      arguments: {
        post_type: "post",
        status: "any",
        limit: 1
      }
    };
  }

  const responseKind = detectResponseKind(normalized);
  const getPostArguments = buildGetPostArguments(normalized);
  if (responseKind !== null && getPostArguments !== null) {
    return {
      mode: "tool",
      toolName: "sitepilot-get-post",
      responseKind,
      arguments: getPostArguments
    };
  }

  if (
    /\b(find|list|show|get|fetch|give|what|which)\b/i.test(normalized) &&
    /\b(posts?|pages?)\b/i.test(normalized)
  ) {
    const postType = detectPostType(normalized) ?? "post";
    const category = extractCategory(normalized);
    return {
      mode: "tool",
      toolName: "sitepilot-find-posts",
      responseKind: "list",
      arguments: {
        post_type: postType,
        status: "any",
        ...(category !== null ? { category } : {}),
        ...(detectOrdering(normalized) ?? {}),
        limit: parseCount(normalized) ?? (asksForSingleLatest(normalized) ? 1 : 10)
      }
    };
  }

  return {
    mode: "reply",
    reply:
      "I can help with general chat and read-only site lookups here. Ask for posts, pages, counts, URLs, timestamps, or post text."
  };
}

type SiteMcpClient = Extract<
  Awaited<ReturnType<typeof createMcpClientForSite>>,
  { ok: true }
>["client"];

type ToolCallOutcome = {
  ok: boolean;
  result: Record<string, unknown>;
};

const MAX_AGENT_TOOL_CALLS = 4;
const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_POST_CONTENT_CHARS = 6_000;

const TOOL_ARGUMENT_KEYS: Record<ConversationToolName, readonly string[]> = {
  "sitepilot-find-posts": [
    "post_type",
    "status",
    "slug",
    "title",
    "search",
    "category",
    "limit",
    "orderby",
    "order"
  ],
  "sitepilot-get-post": [
    "post_id",
    "post_type",
    "status",
    "slug",
    "title",
    "search",
    "category"
  ]
};

const ORDERBY_ALIASES: Record<string, "date" | "modified" | "title" | "ID" | "rand"> = {
  date: "date",
  post_date: "date",
  created: "date",
  created_at: "date",
  published: "date",
  modified: "modified",
  post_modified: "modified",
  updated: "modified",
  modified_at: "modified",
  title: "title",
  post_title: "title",
  id: "ID",
  post_id: "ID",
  rand: "rand",
  random: "rand"
};

const CONVERSATION_AGENT_SYSTEM_PROMPT = [
  "You are SitePilot Conversations mode: a read-only research assistant for one WordPress site.",
  "Never perform or offer writes, publishing, uploads, approvals, or execution. If the operator wants a change, tell them to start a Request.",
  "You can look things up with these read-only tools:",
  '- "sitepilot-find-posts": list/search posts. Arguments (all optional): post_type ("post" | "page" | "any", default "any"), status ("publish" | "draft" | "pending" | "private" | "future" | "any", default "any"), slug, title (exact title match), search (keyword search), category (category slug), limit (1-20, default 10), orderby ("date" = creation date | "modified" | "title" | "ID" | "rand", default "modified"), order ("ASC" | "DESC", default "DESC"). Returns total_matches and matches with post_id, post_type, post_status, post_title, post_name, post_date_gmt, modified_gmt, permalink.',
  '- "sitepilot-get-post": fetch one post in full. Arguments: post_id, or a unique lookup via slug / title / search plus optional post_type, status, category. Returns post_id, post_title, post_name, post_status, post_excerpt, post_content, post_date_gmt, modified_gmt, permalink, category_slugs. If the lookup is not unique it returns error "post_ambiguous" with matches.',
  "Use only the argument names listed above; unknown arguments are rejected.",
  'Respond with exactly one JSON object and nothing else, in one of these shapes: {"action":"tool","tool":"sitepilot-find-posts"|"sitepilot-get-post","arguments":{...}} or {"action":"reply","reply":"..."}.',
  "After each tool call you will receive its result. Call another tool if you need more data (for example retry with search instead of an exact title, or widen the post_type), otherwise reply.",
  'Tips: "last/latest/newest post created" means orderby "date" order "DESC" limit 1. "Random" means orderby "rand". To find a post by a title the operator typed, prefer sitepilot-find-posts with search, since exact title matching is strict about punctuation and quotes.',
  "Answer exactly what was asked, concisely, in plain text. Always include post IDs when you mention specific posts. Do not paste full post content unless the operator asked for the text. Never invent posts, IDs, or values that are not in a tool result; if nothing matched, say so and mention what you searched."
].join("\n");

async function resolveConversationProvider(
  siteId: SiteId
): Promise<ChosenProvider | null> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return null;
  }

  const storage = getSecureStorage();
  const prefs = await loadPlannerPreferences(storage, site.workspaceId);
  const openaiKey = await storage.get({ namespace: "provider", keyId: "openai" });
  const anthropicKey = await storage.get({
    namespace: "provider",
    keyId: "anthropic"
  });
  return chooseConversationProvider({
    preferredProvider: prefs.preferredProvider,
    ...(openaiKey ? { openaiKey } : {}),
    openaiModel: prefs.openaiModel,
    ...(anthropicKey ? { anthropicKey } : {}),
    anthropicModel: prefs.anthropicModel
  });
}

async function loadThreadHistory(
  threadId: ChatThreadId,
  latestText: string
): Promise<string[]> {
  const db = getDatabase();
  const messages = await db.repositories.chatMessages.listByThreadId(threadId);
  const history = messages.map((message) => {
    const role =
      typeof message.author === "object" &&
      message.author !== null &&
      "kind" in message.author
        ? message.author.kind === "assistant"
          ? "assistant"
          : "system"
        : "user";
    return { role, text: message.body.value };
  });
  // The operator's latest message is usually already stored on the thread.
  const last = history.at(-1);
  if (last?.role === "user" && last.text.trim() === latestText.trim()) {
    history.pop();
  }
  return history
    .filter((entry) => entry.role !== "system")
    .slice(-8)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.text.slice(0, 1_500)}`);
}

function isConversationToolName(value: unknown): value is ConversationToolName {
  return value === "sitepilot-find-posts" || value === "sitepilot-get-post";
}

export function sanitizeConversationToolArguments(
  toolName: ConversationToolName,
  args: Record<string, unknown>
): Record<string, unknown> {
  const allowed = TOOL_ARGUMENT_KEYS[toolName];
  const sanitized: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (key === "limit") {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed)) {
        sanitized.limit = Math.max(1, Math.min(20, parsed));
      }
      continue;
    }
    if (key === "post_id") {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        sanitized.post_id = parsed;
      }
      continue;
    }
    if (key === "orderby") {
      const orderby = ORDERBY_ALIASES[String(value).trim().toLowerCase()];
      if (orderby !== undefined) {
        sanitized.orderby = orderby;
      }
      continue;
    }
    if (key === "order") {
      const order = String(value).trim().toUpperCase();
      if (order === "ASC" || order === "DESC") {
        sanitized.order = order;
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      sanitized[key] = String(value);
    }
  }
  return sanitized;
}

function toolErrorMessage(result: Record<string, unknown>): string | null {
  if (typeof result.error === "string" && result.ok !== true) {
    return result.error;
  }
  if (typeof result.raw === "string") {
    return result.raw;
  }
  if (result.ok === false) {
    return "tool_failed";
  }
  return null;
}

async function callConversationTool(
  mcp: SiteMcpClient,
  toolName: ConversationToolName,
  args: Record<string, unknown>
): Promise<ToolCallOutcome> {
  const invoke = async (callArgs: Record<string, unknown>) => {
    const raw = await mcp.callTool(toolName, callArgs);
    const result = normalizeMcpToolResult(raw);
    const isError =
      raw !== null &&
      typeof raw === "object" &&
      (raw as { isError?: unknown }).isError === true;
    return { isError, result };
  };

  let attempt = await invoke(args);
  // Older site plugins reject the sorting arguments; retry without them.
  if (
    (attempt.isError || typeof attempt.result.raw === "string") &&
    ("orderby" in args || "order" in args)
  ) {
    const { orderby: _orderby, order: _order, ...rest } = args;
    const retry = await invoke(rest);
    if (!retry.isError && toolErrorMessage(retry.result) === null) {
      attempt = {
        isError: false,
        result: {
          ...retry.result,
          note: "The site plugin does not support sorting yet, so these results are ordered by last modified date."
        }
      };
    }
  }

  if (attempt.isError) {
    return {
      ok: false,
      result: {
        ok: false,
        error: toolErrorMessage(attempt.result) ?? "tool_failed"
      }
    };
  }
  return { ok: toolErrorMessage(attempt.result) === null, result: attempt.result };
}

function summarizeToolResultForModel(result: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...result };
  if (typeof copy.post_content === "string") {
    const text = stripPostMarkup(copy.post_content);
    copy.post_content =
      text.length > MAX_POST_CONTENT_CHARS
        ? `${text.slice(0, MAX_POST_CONTENT_CHARS)}… [truncated]`
        : text;
  }
  const json = JSON.stringify(copy);
  return json.length > MAX_TOOL_RESULT_CHARS
    ? `${json.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated]`
    : json;
}

type AgentStep =
  | { action: "reply"; reply: string }
  | { action: "tool"; tool: ConversationToolName; arguments: Record<string, unknown> };

function parseAgentStep(text: string): AgentStep | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  } catch {
    const trimmed = text.trim();
    // A model that answers in prose instead of JSON has still answered.
    return trimmed.length > 0 && !trimmed.startsWith("{")
      ? { action: "reply", reply: trimmed }
      : null;
  }
  if (parsed.action === "reply" && typeof parsed.reply === "string") {
    return { action: "reply", reply: parsed.reply };
  }
  const tool = parsed.tool ?? parsed.toolName;
  if (parsed.action === "tool" && isConversationToolName(tool)) {
    const args =
      parsed.arguments !== null &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : {};
    return { action: "tool", tool, arguments: args };
  }
  return null;
}

async function runConversationAgent(input: {
  provider: Exclude<ChosenProvider, { kind: "stub" }>;
  siteId: SiteId;
  history: string[];
  text: string;
}): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: CONVERSATION_AGENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `${
        input.history.length > 0
          ? `Earlier in this conversation:\n${input.history.join("\n")}\n\n`
          : ""
      }Operator message:\n${input.text}`
    }
  ];

  let mcp: SiteMcpClient | null = null;
  for (let toolCalls = 0; toolCalls <= MAX_AGENT_TOOL_CALLS; toolCalls += 1) {
    const completion = await input.provider.client.complete(
      messages,
      input.provider.model
    );
    const step = parseAgentStep(completion.text);
    if (step === null) {
      return null;
    }
    if (step.action === "reply") {
      return step.reply;
    }
    if (toolCalls === MAX_AGENT_TOOL_CALLS) {
      break;
    }

    if (mcp === null) {
      const connection = await createMcpClientForSite(input.siteId);
      if (!connection.ok) {
        return `Failed to connect to the site MCP server: ${connection.message}`;
      }
      mcp = connection.client;
    }

    const args = sanitizeConversationToolArguments(step.tool, step.arguments);
    let resultText: string;
    try {
      const outcome = await callConversationTool(mcp, step.tool, args);
      resultText = summarizeToolResultForModel(outcome.result);
    } catch (error) {
      resultText = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "tool_call_failed"
      });
    }

    messages.push(
      {
        role: "assistant",
        content: JSON.stringify({
          action: "tool",
          tool: step.tool,
          arguments: args
        })
      },
      {
        role: "user",
        content: `Result of ${step.tool} ${JSON.stringify(args)}:\n${resultText}\n\nCall another tool if you still need data, otherwise reply to the operator.`
      }
    );
  }

  messages.push({
    role: "user",
    content: 'Tool budget exhausted. Reply to the operator now using {"action":"reply","reply":"..."} based on the results above.'
  });
  const final = await input.provider.client.complete(messages, input.provider.model);
  const step = parseAgentStep(final.text);
  return step?.action === "reply" ? step.reply : null;
}

function formatMatchLine(match: unknown, index: number): string {
  if (match === null || typeof match !== "object" || Array.isArray(match)) {
    return `${index + 1}. Unknown post`;
  }
  const record = match as Record<string, unknown>;
  const title = typeof record.post_title === "string" && record.post_title.length > 0
    ? record.post_title
    : "Untitled";
  const postId = typeof record.post_id === "number" ? `#${record.post_id} · ` : "";
  const status = typeof record.post_status === "string" ? ` · ${record.post_status}` : "";
  const created =
    typeof record.post_date_gmt === "string" && record.post_date_gmt.length > 0
      ? ` · created ${record.post_date_gmt}`
      : "";
  return `${index + 1}. ${postId}${title}${status}${created}`;
}

function formatFindPostsReply(
  result: Record<string, unknown>,
  responseKind: "list" | "count"
): string {
  const error = toolErrorMessage(result);
  if (error !== null) {
    return `The site lookup failed: ${error}`;
  }

  const matches = Array.isArray(result.matches) ? result.matches : [];
  const totalMatches =
    typeof result.total_matches === "number" ? result.total_matches : matches.length;

  if (responseKind === "count") {
    return `${totalMatches}`;
  }

  if (matches.length === 0) {
    return "No matching posts found.";
  }

  const lines = matches.slice(0, 20).map(formatMatchLine);
  const header =
    totalMatches > matches.length
      ? `Showing ${matches.length} of ${totalMatches} matching items:`
      : `${totalMatches} matching ${totalMatches === 1 ? "item" : "items"}:`;
  const note = typeof result.note === "string" ? `\n\n${result.note}` : "";
  return `${header}\n${lines.join("\n")}${note}`;
}

function formatGetPostReply(
  result: Record<string, unknown>,
  responseKind: Exclude<ResponseKind, "list" | "count">
): string {
  if (result.ok !== true) {
    const error = toolErrorMessage(result) ?? "Failed to load the post.";
    if (error === "post_ambiguous" && Array.isArray(result.matches)) {
      return `More than one post matched. Refine the request with a slug or exact title.\n${formatFindPostsReply({ ...result, ok: true, error: undefined }, "list")}`;
    }
    if (error === "post_not_found") {
      return "No matching post was found.";
    }
    return `Failed to load the post: ${error}`;
  }

  const title =
    typeof result.post_title === "string" ? result.post_title : "Untitled";
  const postId = typeof result.post_id === "number" ? result.post_id : null;
  const label = `${title}${postId !== null ? ` (#${postId})` : ""}`;
  const status = typeof result.post_status === "string" ? result.post_status : "";
  const content =
    typeof result.post_content === "string" ? stripPostMarkup(result.post_content) : "";
  const permalink =
    typeof result.permalink === "string" ? result.permalink : "";
  const created =
    typeof result.created_at === "string"
      ? result.created_at
      : typeof result.post_date_gmt === "string"
        ? result.post_date_gmt
        : "";
  const modified =
    typeof result.modified_at === "string"
      ? result.modified_at
      : typeof result.modified_gmt === "string"
        ? result.modified_gmt
        : "";

  if (responseKind === "id") {
    return postId !== null
      ? `"${title}" has post ID ${postId}${status ? ` (${status})` : ""}.`
      : `"${title}" has no post ID available.`;
  }

  if (responseKind === "url") {
    return permalink.length > 0
      ? `${label} · ${permalink}`
      : `${label} · URL unavailable`;
  }

  if (responseKind === "created") {
    return created.length > 0
      ? `${label} was created at ${created}.`
      : `${label} has no creation timestamp available.`;
  }

  if (responseKind === "modified") {
    return modified.length > 0
      ? `${label} was last modified at ${modified}.`
      : `${label} has no modified timestamp available.`;
  }

  return `${label}${status ? ` · ${status}` : ""}\n\n${content.length > 0 ? content : "This post has no text content."}`;
}

async function countPostTypes(input: {
  siteId: SiteId;
  postTypes: Array<"post" | "page">;
}): Promise<string> {
  const mcp = await createMcpClientForSite(input.siteId);
  if (!mcp.ok) {
    return `Failed to connect to the site MCP server: ${mcp.message}`;
  }

  const results = await Promise.all(
    input.postTypes.map(async (postType) => {
      const raw = await mcp.client.callTool("sitepilot-find-posts", {
        post_type: postType,
        status: "any",
        limit: 1
      });
      const result = normalizeMcpToolResult(raw);
      const count =
        typeof result.total_matches === "number" ? result.total_matches : 0;
      return { postType, count };
    })
  );

  return results
    .map(({ postType, count }) => `${count} ${postType}${count === 1 ? "" : "s"}`)
    .join(" · ");
}

async function runFallbackPlan(input: {
  siteId: SiteId;
  text: string;
  plan: Exclude<ConversationPlan, { mode: "external_page" }>;
}): Promise<string> {
  const { plan } = input;
  if (plan.mode === "reply") {
    return plan.reply;
  }
  if (plan.mode === "multi_count") {
    return countPostTypes({ siteId: input.siteId, postTypes: plan.postTypes });
  }

  const mcp = await createMcpClientForSite(input.siteId);
  if (!mcp.ok) {
    return `Failed to connect to the site MCP server: ${mcp.message}`;
  }

  try {
    const outcome = await callConversationTool(
      mcp.client,
      plan.toolName,
      sanitizeConversationToolArguments(plan.toolName, plan.arguments)
    );
    if (plan.toolName === "sitepilot-find-posts") {
      return formatFindPostsReply(
        outcome.result,
        plan.responseKind === "count" ? "count" : "list"
      );
    }
    if (plan.responseKind !== "list" && plan.responseKind !== "count") {
      return formatGetPostReply(outcome.result, plan.responseKind);
    }
    return "That conversation lookup could not be resolved.";
  } catch (error) {
    return error instanceof Error ? error.message : "The read-only MCP call failed.";
  }
}

export type ConversationReply = {
  text: string;
  requestPrompt?: string;
  requestThreadTitle?: string;
};

async function buildExternalPageConversationReply(input: {
  text: string;
  url: string;
  createRequest: boolean;
}): Promise<ConversationReply> {
  try {
    const page = await fetchExternalPageText(input.url);
    if (input.createRequest) {
      return {
        text: buildExternalPageReply({
          page,
          createdRequestTitle: buildExternalPageRequestTitle(page)
        }),
        requestPrompt: buildExternalPageRequestPrompt({
          operatorText: input.text,
          page
        }),
        requestThreadTitle: buildExternalPageRequestTitle(page)
      };
    }
    return {
      text: buildExternalPageReply({ page })
    };
  } catch (error) {
    return {
      text:
        error instanceof Error
          ? error.message
          : "Failed to fetch readable text from that page."
    };
  }
}

export async function buildConversationReply(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  text: string;
}): Promise<ConversationReply> {
  const text = input.text.trim();
  const externalResearch = parseExternalResearchIntent(text);
  if (externalResearch) {
    return buildExternalPageConversationReply({
      text: input.text,
      url: externalResearch.url,
      createRequest: externalResearch.shouldCreateRequest
    });
  }

  const fallbackPlan = fallbackConversationPlan(text);
  if (looksLikeWriteRequest(text) && fallbackPlan.mode === "reply") {
    return { text: fallbackPlan.reply };
  }

  const provider = await resolveConversationProvider(input.siteId);
  if (provider === null) {
    return { text: "Site not found." };
  }

  if (provider.kind !== "stub") {
    try {
      const history = await loadThreadHistory(input.threadId, text);
      const reply = await runConversationAgent({
        provider,
        siteId: input.siteId,
        history,
        text
      });
      if (reply !== null && reply.trim().length > 0) {
        return { text: reply.trim() };
      }
    } catch {
      // Fall through to the deterministic lookup below.
    }
  }

  if (fallbackPlan.mode === "external_page") {
    return buildExternalPageConversationReply({
      text: input.text,
      url: fallbackPlan.url,
      createRequest: fallbackPlan.createRequest
    });
  }
  return {
    text: await runFallbackPlan({ siteId: input.siteId, text, plan: fallbackPlan })
  };
}
