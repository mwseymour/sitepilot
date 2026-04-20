import { randomUUID } from "node:crypto";

import {
  actionPlanSchema,
  type Action,
  type ActionPlan,
  type PlannerContext
} from "@sitepilot/contracts";
import type {
  ActionId,
  ActionPlanId,
  RequestId,
  SiteId
} from "@sitepilot/domain";
import type {
  ChatMessage,
  ChatModelClient
} from "@sitepilot/provider-adapters";

import { extractJsonObject } from "./json-extract.js";

const PLANNER_PROMPT_VERSION = "sitepilot-plan-v3";
const ADVANCED_BLOCK_NAMES = new Set([
  "core/buttons",
  "core/columns",
  "core/cover",
  "core/embed",
  "core/gallery",
  "core/image",
  "core/media-text",
  "core/separator",
  "core/spacer",
  "core/table",
  "core/video"
]);
const HIGH_RISK_BLOCK_NAMES = new Set([
  "core/buttons",
  "core/cover",
  "core/gallery",
  "core/media-text",
  "core/table"
]);
const CONTENT_KEYS = ["content", "postContent", "post_content"] as const;
const BLOCK_COMMENT_RE =
  /<!--\s*(\/?)wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+([\s\S]*?))?\s*(\/)?-->/gi;

type ContentNormalizationResult = {
  content: string;
  warnings: string[];
};

function lastUserPlainText(context: PlannerContext): string {
  const users = context.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return last?.text?.trim() ?? "(no user message)";
}

function userCorpusForRequest(
  context: PlannerContext,
  requestId: RequestId
): string {
  const tagged = context.messages.filter(
    (m) => m.role === "user" && m.requestId === requestId
  );
  const rows =
    tagged.length > 0
      ? tagged
      : context.messages.filter((m) => m.role === "user");
  return rows
    .map((m) => m.text)
    .join("\n")
    .trim();
}

function normalizeActionType(type: string): string {
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();
}

function actionMayWritePostContent(type: string): boolean {
  const t = normalizeActionType(type);
  return (
    t === "create_draft_post" ||
    t === "create_draft_content" ||
    t === "create_post_draft" ||
    t === "sitepilot_create_draft_post" ||
    t === "update_post" ||
    t === "update_post_fields" ||
    t === "update_post_content" ||
    t === "edit_post_fields" ||
    t === "sitepilot_update_post_fields"
  );
}

function pickContentKey(
  input: Record<string, unknown>
): (typeof CONTENT_KEYS)[number] | undefined {
  return CONTENT_KEYS.find((key) => typeof input[key] === "string");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stripHtmlToPlainText(raw: string): string[] {
  const text = raw
    .replace(BLOCK_COMMENT_RE, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6])>/gi, "\n\n")
    .replace(/<(p|div|section|article|li|ul|ol|h[1-6])\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "");

  return text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

function paragraphsToBlocks(paragraphs: string[]): string {
  return paragraphs
    .map(
      (paragraph) =>
        `<!-- wp:paragraph --><p>${escapeHtml(paragraph)}</p><!-- /wp:paragraph -->`
    )
    .join("\n");
}

function requestAllowsAdvancedBlocks(requestText: string): boolean {
  return /\b(image|images|photo|photos|headshot|headshots|gallery|media|left\/right|left-right|alternating|alternates|columns?|column|side[- ]by[- ]side|button|cta|cover|embed|video|table|separator|spacer)\b/i.test(
    requestText
  );
}

function findAdvancedBlockNames(content: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  BLOCK_COMMENT_RE.lastIndex = 0;
  while ((match = BLOCK_COMMENT_RE.exec(content)) !== null) {
    const rawBlockName = match[2];
    if (rawBlockName === undefined) {
      continue;
    }
    if (match[1] === "/") {
      continue;
    }
    const blockName = `core/${rawBlockName}`;
    if (ADVANCED_BLOCK_NAMES.has(blockName)) {
      found.add(blockName);
    }
  }
  return [...found];
}

function findHighRiskBlockNames(content: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  BLOCK_COMMENT_RE.lastIndex = 0;
  while ((match = BLOCK_COMMENT_RE.exec(content)) !== null) {
    const rawBlockName = match[2];
    if (rawBlockName === undefined || match[1] === "/") {
      continue;
    }
    const blockName = `core/${rawBlockName}`;
    if (HIGH_RISK_BLOCK_NAMES.has(blockName)) {
      found.add(blockName);
    }
  }
  return [...found];
}

function validateBlockSerialization(content: string): string[] {
  const issues: string[] = [];
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  BLOCK_COMMENT_RE.lastIndex = 0;

  while ((match = BLOCK_COMMENT_RE.exec(content)) !== null) {
    const isClosing = match[1] === "/";
    const blockName = match[2];
    if (blockName === undefined) {
      continue;
    }
    const attrs = match[3]?.trim();
    const isSelfClosing = match[4] === "/";

    if (isClosing) {
      const open = stack.pop();
      if (open !== blockName) {
        issues.push(
          `mismatched block delimiter: expected closing tag for "${open ?? "none"}" but found "${blockName}"`
        );
      }
      continue;
    }

    if (attrs !== undefined && attrs.length > 0) {
      try {
        JSON.parse(attrs);
      } catch {
        issues.push(`invalid block attrs JSON for "${blockName}"`);
      }
    }

    if (!isSelfClosing) {
      stack.push(blockName);
    }
  }

  if (stack.length > 0) {
    issues.push(
      `unclosed block delimiters remain: ${stack.map((name) => `"${name}"`).join(", ")}`
    );
  }

  return issues;
}

function normalizePostContent(
  rawContent: string,
  requestText: string
): ContentNormalizationResult {
  const content = rawContent.trim();
  if (content.length === 0) {
    return { content: rawContent, warnings: [] };
  }

  if (!content.includes("<!-- wp:")) {
    const paragraphs = stripHtmlToPlainText(content);
    if (paragraphs.length === 0) {
      return { content: rawContent, warnings: [] };
    }
    return {
      content: paragraphsToBlocks(paragraphs),
      warnings: [
        "Planner returned post content without Gutenberg block serialization; normalized it into paragraph blocks."
      ]
    };
  }

  const warnings: string[] = [];
  const highRiskBlocks = findHighRiskBlockNames(content);
  if (highRiskBlocks.length > 0) {
    const paragraphs = stripHtmlToPlainText(content);
    if (paragraphs.length > 0) {
      return {
        content: paragraphsToBlocks(paragraphs),
        warnings: [
          `Planner used high-risk Gutenberg block types (${highRiskBlocks.join(", ")}); normalized content to paragraph blocks to avoid editor recovery.`
        ]
      };
    }
    warnings.push(
      `Planner used high-risk Gutenberg block types (${highRiskBlocks.join(", ")}), which commonly break serialization.`
    );
  }

  const serializationIssues = validateBlockSerialization(content);
  if (serializationIssues.length > 0) {
    const paragraphs = stripHtmlToPlainText(content);
    if (paragraphs.length > 0) {
      return {
        content: paragraphsToBlocks(paragraphs),
        warnings: [
          `Planner returned malformed Gutenberg block serialization (${serializationIssues.join("; ")}); fell back to paragraph blocks.`
        ]
      };
    }
    warnings.push(
      `Planner returned malformed Gutenberg block serialization (${serializationIssues.join("; ")}).`
    );
  }

  const advancedBlocks = findAdvancedBlockNames(content);
  if (advancedBlocks.length > 0 && !requestAllowsAdvancedBlocks(requestText)) {
    warnings.push(
      `Planner added advanced blocks not clearly requested by the operator: ${advancedBlocks.join(", ")}.`
    );
  }

  if (
    /\b(placeholder|lorem ipsum|content about|section about|bio goes here|insert image|alternating blocks)\b/i.test(
      content
    )
  ) {
    warnings.push(
      "Planner content still contains placeholder or meta-descriptive copy instead of final user-facing copy."
    );
  }

  return { content: rawContent, warnings };
}

function normalizePlanPostContent(
  plan: ActionPlan,
  requestText: string
): ActionPlan {
  const validationWarnings = [...plan.validationWarnings];
  const proposedActions = plan.proposedActions.map((action) => {
    if (!actionMayWritePostContent(action.type)) {
      return action;
    }

    const input = action.input as Record<string, unknown>;
    const contentKey = pickContentKey(input);
    if (contentKey === undefined) {
      return action;
    }

    const currentContent = input[contentKey];
    if (typeof currentContent !== "string") {
      return action;
    }

    const normalized = normalizePostContent(currentContent, requestText);
    validationWarnings.push(...normalized.warnings);
    if (normalized.content === currentContent) {
      return action;
    }

    return {
      ...action,
      input: {
        ...input,
        [contentKey]: normalized.content
      }
    } satisfies Action;
  });

  return actionPlanSchema.parse({
    ...plan,
    proposedActions,
    validationWarnings: [...new Set(validationWarnings)]
  });
}

export function buildStubActionPlan(input: {
  context: PlannerContext;
  requestId: RequestId;
  siteId: SiteId;
  nowIso: string;
}): ActionPlan {
  const summary = lastUserPlainText(input.context);
  const planId = randomUUID() as ActionPlanId;
  const interpretId = randomUUID() as ActionId;
  const draftPostId = randomUUID() as ActionId;
  const draftTitle =
    summary.length > 80
      ? `Draft: ${summary.slice(0, 77)}…`
      : `Draft: ${summary}`;

  const draft: ActionPlan = {
    id: planId,
    requestId: input.requestId,
    siteId: input.siteId,
    requestSummary: summary.slice(0, 500),
    assumptions: [
      "Stub planner: no provider API key configured; this plan is a deterministic placeholder."
    ],
    openQuestions: [],
    targetEntities: [],
    proposedActions: [
      {
        id: interpretId,
        type: "interpret_request",
        version: 1,
        input: { summary },
        targetEntityRefs: [],
        permissionRequirement: "read_site",
        riskLevel: "low",
        dryRunCapable: true,
        rollbackSupported: true
      },
      {
        id: draftPostId,
        type: "create_draft_post",
        version: 1,
        input: {
          title: draftTitle,
          content: summary,
          post_type: "post"
        },
        targetEntityRefs: [],
        permissionRequirement: "edit_posts",
        riskLevel: "low",
        dryRunCapable: true,
        rollbackSupported: false
      }
    ],
    dependencies: [],
    approvalRequired: false,
    riskLevel: "low",
    rollbackNotes: [],
    validationWarnings: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };

  return actionPlanSchema.parse(draft);
}

export async function buildLlmActionPlan(input: {
  context: PlannerContext;
  requestId: RequestId;
  siteId: SiteId;
  nowIso: string;
  client: ChatModelClient;
  model: string;
}): Promise<{
  plan: ActionPlan;
  usage: { inputTokens: number; outputTokens: number; provider: string };
}> {
  const system = `You are SitePilot's planning engine. Reply with a single JSON object only (no markdown) that matches this shape:
{
  "requestSummary": string (non-empty),
  "assumptions": string[],
  "openQuestions": string[],
  "targetEntities": string[],
  "proposedActions": [{
    "id": string (unique id),
    "type": string (machine-readable action type),
    "version": positive int,
    "input": object (string keys to JSON values),
    "targetEntityRefs": string[],
    "permissionRequirement": string,
    "riskLevel": "low"|"medium"|"high"|"critical",
    "dryRunCapable": boolean,
    "rollbackSupported": boolean
  }] (at least one),
  "dependencies": string[],
  "approvalRequired": boolean,
  "riskLevel": "low"|"medium"|"high"|"critical",
  "rollbackNotes": string[],
  "validationWarnings": string[]
}
Use the operator request and site context. Keep actions conservative.
Use targetSummaries and priorChanges. If the thread already created a post or page and a later request is clearly modifying that same content, reuse that known entity and include its identifier such as post_id in the action input.
If an exact post_id is not known but the target can be uniquely discovered at execution time, include lookup fields such as lookup_status, lookup_slug, lookup_title, lookup_search, and lookup_post_type in the update action input (same object as post_id would use). Example: {"type":"update_post_fields","input":{"lookup_title":"Hello Matt","lookup_status":"draft","content":"..."}}.
Do not propose update actions that lack both a concrete post_id and resolvable lookup fields.
Do not invent deliverables, sections, media, layouts, or block types the operator did not ask for. Default to the smallest faithful set of blocks, usually headings, paragraphs, and lists only. Do not add image/media-text/columns/gallery/buttons/cover/separator/spacer/embed/table/video blocks unless the request explicitly requires them.
For content-writing actions, prefer structured block data over hand-written serialized HTML whenever the request needs nested/layout/media blocks. Use input.blocks as an array of WordPress parsed block objects that can be passed to WordPress serialize_blocks(): each block has blockName, attrs, innerBlocks, innerHTML, and innerContent. Use input.content only for simple text-only block markup when no nested layout is needed.

WordPress Gutenberg content rules for create_draft_post and update_post_fields (post_content / content field):
- Store body content as block serialization: each block uses delimiters <!-- wp:blockname {json attrs} --> ...inner HTML... <!-- /wp:blockname -->. Do not wrap the whole article in a single wp:html block that only describes intent (e.g. never use placeholder text like "Content about X with alternating blocks").
- Write full copy the user asked for in wp:paragraph blocks (or headings where appropriate). When the user requests photos or headshots, you MUST include wp:image blocks with real, public https:// URLs (for example direct Wikimedia Commons file URLs on upload.wikimedia.org). Use "id":0 in the block JSON when the file is not yet in the Media Library; include the same URL in the block attrs and in the <img src="...">.
- For nested/layout/media blocks, prefer input.blocks so WordPress can serialize the parsed block tree. Do not improvise saved HTML when you can provide parsed blocks instead.
- Every opening block delimiter must have the correct matching closing delimiter, in the correct nesting order. Block attrs must be valid JSON. Do not emit malformed or partially-open blocks.
- Do not output planning notes, placeholder labels, or descriptions of intended blocks inside the post content. Output only the final user-facing content.
- The content value is embedded inside JSON: escape double quotes and newlines in the serialized blocks so the overall planner output remains valid JSON.`;

  const user = JSON.stringify(
    {
      plannerContext: input.context,
      requestId: input.requestId,
      siteId: input.siteId,
      promptVersion: PLANNER_PROMPT_VERSION
    },
    null,
    2
  );

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const result = await input.client.complete(messages, input.model);
  const raw = extractJsonObject(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Planner model returned non-JSON output.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Planner model JSON must be an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const planId = randomUUID() as ActionPlanId;
  const merged = {
    ...obj,
    id: planId,
    requestId: input.requestId,
    siteId: input.siteId,
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };

  const parsedPlan = actionPlanSchema.parse(merged);
  const plan = normalizePlanPostContent(
    parsedPlan,
    userCorpusForRequest(input.context, input.requestId)
  );

  return {
    plan,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      provider: input.client.providerId
    }
  };
}
