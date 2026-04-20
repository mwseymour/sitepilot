import {
  actionPlanSchema,
  type ActionPlan,
  type PlannerContext
} from "@sitepilot/contracts";

import {
  actionSupportsPostLookup,
  buildPostLookupArguments,
  findNumericPostId
} from "./post-target-resolution.js";

function userCorpusForRequest(
  context: PlannerContext,
  requestId: string
): string {
  const tagged = context.messages.filter(
    (m) => m.role === "user" && m.requestId === requestId
  );
  const rows =
    tagged.length > 0
      ? tagged
      : context.messages.filter((m) => m.role === "user");
  return rows.map((m) => m.text).join("\n");
}

function normalizeTitleCandidate(raw: string): string | undefined {
  const t = raw.trim().replace(/\s+/g, " ");
  if (t.length < 2 || t.length > 200) {
    return undefined;
  }
  return t;
}

/**
 * Best-effort extraction of lookup_title / lookup_status from natural-language
 * operator text when the planner omitted structured lookup fields.
 */
export function inferPostLookupHintsFromCorpus(corpus: string): {
  lookup_title?: string;
  lookup_status?: string;
} {
  const out: { lookup_title?: string; lookup_status?: string } = {};

  if (
    /\bdraft\b/i.test(corpus) &&
    (/\bdraft\s+post\b/i.test(corpus) ||
      /\bonly\s+existing\s+draft\b/i.test(corpus) ||
      /\bexisting\s+Draft\b/i.test(corpus) ||
      /\bfor\s+draft\s+posts\b/i.test(corpus) ||
      /\bone\s+draft\b/i.test(corpus))
  ) {
    out.lookup_status = "draft";
  }

  const boundary = String.raw`(?=\s+and\s+update\b|\s+to\s+update\b|,|\.|\s+Additional\b|$|\n)`;
  const patterns: RegExp[] = [
    new RegExp(
      String.raw`\bpost\s+titled\s+["']([^"'\n]+)["']`,
      "i"
    ),
    new RegExp(String.raw`\bpost\s+titled\s+(.+?)${boundary}`, "i"),
    new RegExp(
      String.raw`\bdraft\s+post\s+(?:called|named)\s+["']([^"'\n]+)["']`,
      "i"
    ),
    new RegExp(
      String.raw`\bdraft\s+post\s+(?:called|named)\s+(.+?)${boundary}`,
      "i"
    ),
    new RegExp(String.raw`\bpost\s+(?:called|named)\s+["']([^"'\n]+)["']`, "i"),
    new RegExp(
      String.raw`\bpost\s+(?:called|named)\s+(.+?)${boundary}`,
      "i"
    ),
    new RegExp(
      String.raw`(?:find|finding)\s+(?:the\s+)?draft\s+post\s+called\s+["']([^"'\n]+)["']`,
      "i"
    ),
    new RegExp(
      String.raw`(?:find|finding)\s+(?:the\s+)?draft\s+post\s+called\s+(.+?)${boundary}`,
      "i"
    )
  ];

  for (const re of patterns) {
    const m = corpus.match(re);
    const cand = m?.[1] ? normalizeTitleCandidate(m[1]) : undefined;
    if (cand !== undefined) {
      out.lookup_title = cand;
      break;
    }
  }

  return out;
}

function hasExplicitLookupTitle(input: Record<string, unknown>): boolean {
  const keys = [
    "lookup_title",
    "lookupTitle",
    "target_title",
    "targetTitle",
    "existing_title",
    "existingTitle",
    "lookup_search",
    "lookupSearch",
    "target_search",
    "targetSearch",
    "search",
    "query",
    "lookup_slug",
    "lookupSlug",
    "target_slug",
    "targetSlug",
    "post_name",
    "postSlug",
    "slug"
  ];
  return keys.some((k) => {
    const v = input[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

function hasExplicitLookupStatus(input: Record<string, unknown>): boolean {
  const keys = [
    "lookup_status",
    "lookupStatus",
    "target_status",
    "targetStatus",
    "post_status",
    "postStatus",
    "status"
  ];
  return keys.some((k) => {
    const v = input[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * Fills lookup_title / lookup_status on update-like actions when the model
 * omitted them but the thread text names the target post (e.g. draft "Hello Matt").
 */
export function enrichActionPlanWithPostLookupFromContext(
  plan: ActionPlan,
  context: PlannerContext
): ActionPlan {
  const corpus = userCorpusForRequest(context, plan.requestId);
  const hints = inferPostLookupHintsFromCorpus(corpus);
  if (hints.lookup_title === undefined && hints.lookup_status === undefined) {
    return plan;
  }

  let enrichedAny = false;
  const proposedActions = plan.proposedActions.map((action) => {
    if (!actionSupportsPostLookup(action.type)) {
      return action;
    }
    const cur = action.input as Record<string, unknown>;
    if (findNumericPostId(cur) !== undefined) {
      return action;
    }
    if (buildPostLookupArguments(cur) !== null) {
      return action;
    }

    const input = { ...cur };
    let touched = false;
    if (hints.lookup_title !== undefined && !hasExplicitLookupTitle(input)) {
      input.lookup_title = hints.lookup_title;
      touched = true;
    }
    if (hints.lookup_status !== undefined && !hasExplicitLookupStatus(input)) {
      input.lookup_status = hints.lookup_status;
      touched = true;
    }

    if (!touched || buildPostLookupArguments(input) === null) {
      return action;
    }
    enrichedAny = true;
    return { ...action, input };
  });

  if (!enrichedAny) {
    return plan;
  }

  const assumption =
    "Inferred post lookup fields (lookup_title / lookup_status) from the operator request text so the target post can be resolved at execution time.";
  const assumptions = plan.assumptions.includes(assumption)
    ? plan.assumptions
    : [...plan.assumptions, assumption];

  return actionPlanSchema.parse({
    ...plan,
    proposedActions,
    assumptions
  });
}
