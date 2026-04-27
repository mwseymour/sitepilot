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
import { loadPlannerPreferences } from "./planner-preferences-service.js";
import { createMcpClientForSite } from "./site-mcp-client.js";

type ChosenProvider =
  | { kind: "openai"; client: ChatModelClient; model: string }
  | { kind: "anthropic"; client: ChatModelClient; model: string }
  | { kind: "stub" };

type ConversationPlan =
  | { mode: "reply"; reply: string }
  | {
      mode: "tool";
      toolName: "sitepilot-find-posts" | "sitepilot-get-post";
      responseKind:
        | "list"
        | "count"
        | "content"
        | "url"
        | "created"
        | "modified";
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
  const match = text.match(/\b(?:last|latest|first|show|fetch|get|list|find)\s+(\d{1,2})\b/i);
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

function detectResponseKind(
  text: string
): "content" | "url" | "created" | "modified" | null {
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

  if (/\b(find|list|show|get|fetch)\b/i.test(normalized) && /\b(posts?|pages?)\b/i.test(normalized)) {
    const postType = detectPostType(normalized) ?? "post";
    return {
      mode: "tool",
      toolName: "sitepilot-find-posts",
      responseKind: "list",
      arguments: {
        post_type: postType,
        status: "any",
        ...(extractCategory(normalized) !== null
          ? { category: extractCategory(normalized) ?? undefined }
          : {}),
        limit: parseCount(normalized) ?? 10
      }
    };
  }

  return {
    mode: "reply",
    reply:
      "I can help with general chat and read-only site lookups here. Ask for posts, pages, counts, URLs, timestamps, or post text."
  };
}

async function planConversationReply(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  text: string;
}): Promise<ConversationPlan> {
  if (looksLikeWriteRequest(input.text)) {
    return fallbackConversationPlan(input.text);
  }

  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
  if (!site) {
    return {
      mode: "reply",
      reply: "Site not found."
    };
  }

  const storage = getSecureStorage();
  const prefs = await loadPlannerPreferences(storage, site.workspaceId);
  const openaiKey = await storage.get({ namespace: "provider", keyId: "openai" });
  const anthropicKey = await storage.get({
    namespace: "provider",
    keyId: "anthropic"
  });
  const chosen = chooseConversationProvider({
    preferredProvider: prefs.preferredProvider,
    ...(openaiKey ? { openaiKey } : {}),
    openaiModel: prefs.openaiModel,
    ...(anthropicKey ? { anthropicKey } : {}),
    anthropicModel: prefs.anthropicModel
  });

  if (chosen.kind === "stub") {
    return fallbackConversationPlan(input.text);
  }

  const messages = await db.repositories.chatMessages.listByThreadId(input.threadId);
  const recent = messages.slice(-6).map((message) => {
    const role =
      typeof message.author === "object" &&
      message.author !== null &&
      "kind" in message.author
        ? message.author.kind === "assistant"
          ? "assistant"
          : "system"
        : "user";
    return `${role.toUpperCase()}: ${message.body.value}`;
  });

  const prompt: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are SitePilot Conversations mode. This mode is strictly read-only. Never suggest or perform writes, execution, publishing, uploads, or approvals here; tell the operator to use Requests instead. Return JSON only. Valid shapes: {\"mode\":\"reply\",\"reply\":\"...\"}, {\"mode\":\"tool\",\"toolName\":\"sitepilot-find-posts\"|\"sitepilot-get-post\",\"responseKind\":\"list\"|\"count\"|\"content\"|\"url\"|\"created\"|\"modified\",\"arguments\":{...}}, or {\"mode\":\"multi_count\",\"postTypes\":[\"post\",\"page\"]}. Use sitepilot-find-posts for listing/finding/searching/counting posts. Use sitepilot-get-post for retrieving one post's text/content/url/timestamps by title, slug, or id. For category requests, use the category slug in arguments.category. Prefer post_type \"post\" unless the request clearly says otherwise. For general non-site chat, use mode reply."
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Recent thread context:\n${recent.join("\n")}\n\nLatest operator message:\n${input.text}`
        }
      ]
    }
  ];

  try {
    const result = await chosen.client.complete(prompt, chosen.model);
    const parsed = JSON.parse(extractJsonObject(result.text)) as Partial<ConversationPlan>;
    if (parsed.mode === "reply" && typeof parsed.reply === "string") {
      return { mode: "reply", reply: parsed.reply };
    }
    if (
      parsed.mode === "tool" &&
      (parsed.toolName === "sitepilot-find-posts" ||
        parsed.toolName === "sitepilot-get-post") &&
      (parsed.responseKind === "list" ||
        parsed.responseKind === "count" ||
        parsed.responseKind === "content" ||
        parsed.responseKind === "url" ||
        parsed.responseKind === "created" ||
        parsed.responseKind === "modified") &&
      parsed.arguments !== null &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
    ) {
      return {
        mode: "tool",
        toolName: parsed.toolName,
        responseKind: parsed.responseKind,
        arguments: parsed.arguments as Record<string, unknown>
      };
    }
    if (
      parsed.mode === "multi_count" &&
      Array.isArray(parsed.postTypes) &&
      parsed.postTypes.every((value) => value === "post" || value === "page")
    ) {
      return {
        mode: "multi_count",
        postTypes: parsed.postTypes
      };
    }
  } catch {
    return fallbackConversationPlan(input.text);
  }

  return fallbackConversationPlan(input.text);
}

function formatFindPostsReply(
  result: Record<string, unknown>,
  responseKind: "list" | "count"
): string {
  const matches = Array.isArray(result.matches) ? result.matches : [];
  const totalMatches =
    typeof result.total_matches === "number" ? result.total_matches : matches.length;

  if (responseKind === "count") {
    return `${totalMatches}`;
  }

  if (matches.length === 0) {
    return "No matching posts found.";
  }

  const lines = matches.slice(0, 20).map((match, index) => {
    if (match === null || typeof match !== "object" || Array.isArray(match)) {
      return `${index + 1}. Unknown post`;
    }
    const record = match as Record<string, unknown>;
    const title = typeof record.post_title === "string" ? record.post_title : "Untitled";
    const slug = typeof record.post_name === "string" ? record.post_name : "";
    const status = typeof record.post_status === "string" ? record.post_status : "";
    const postId = typeof record.post_id === "number" ? `#${record.post_id}` : "";
    return `${index + 1}. ${title}${slug ? ` (${slug})` : ""}${status ? ` · ${status}` : ""}${postId ? ` · ${postId}` : ""}`;
  });

  return `${totalMatches} matching ${totalMatches === 1 ? "item" : "items"}:\n${lines.join("\n")}`;
}

function formatGetPostReply(
  result: Record<string, unknown>,
  responseKind: "content" | "url" | "created" | "modified"
): string {
  if (result.ok !== true) {
    const error =
      typeof result.error === "string" ? result.error : "Failed to load the post.";
    if (error === "post_ambiguous" && Array.isArray(result.matches)) {
      return `More than one post matched. Refine the request with a slug or exact title.\n${formatFindPostsReply(result, "list")}`;
    }
    if (error === "post_not_found") {
      return "No matching post was found.";
    }
    return `Failed to load the post: ${error}`;
  }

  const title =
    typeof result.post_title === "string" ? result.post_title : "Untitled";
  const slug = typeof result.post_name === "string" ? result.post_name : "";
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

  if (responseKind === "url") {
    return permalink.length > 0
      ? `${title}${slug ? ` (${slug})` : ""} · ${permalink}`
      : `${title}${slug ? ` (${slug})` : ""} · URL unavailable`;
  }

  if (responseKind === "created") {
    return created.length > 0
      ? `${title}${slug ? ` (${slug})` : ""} was created at ${created}.`
      : `${title}${slug ? ` (${slug})` : ""} has no creation timestamp available.`;
  }

  if (responseKind === "modified") {
    return modified.length > 0
      ? `${title}${slug ? ` (${slug})` : ""} was last modified at ${modified}.`
      : `${title}${slug ? ` (${slug})` : ""} has no modified timestamp available.`;
  }

  return `${title}${slug ? ` (${slug})` : ""}${status ? ` · ${status}` : ""}\n\n${content.length > 0 ? content : "This post has no text content."}`;
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

export async function buildConversationReply(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  text: string;
}): Promise<string> {
  const plan = await planConversationReply(input);
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
    const raw = await mcp.client.callTool(plan.toolName, plan.arguments);
    const result = normalizeMcpToolResult(raw);
    if (
      plan.toolName === "sitepilot-find-posts" &&
      (plan.responseKind === "list" || plan.responseKind === "count")
    ) {
      return formatFindPostsReply(result, plan.responseKind);
    }
    if (
      plan.toolName === "sitepilot-get-post" &&
      (plan.responseKind === "content" ||
        plan.responseKind === "url" ||
        plan.responseKind === "created" ||
        plan.responseKind === "modified")
    ) {
      return formatGetPostReply(result, plan.responseKind);
    }
    return "That conversation lookup could not be resolved.";
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The read-only MCP call failed.";
  }
}
