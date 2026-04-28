import type { ActionPlan } from "@sitepilot/contracts";

export type PlanValidationOutcome =
  | { kind: "pass" }
  | { kind: "warnings"; messages: string[] }
  | { kind: "blocked_clarification"; messages: string[] }
  | { kind: "blocked_approval"; messages: string[] }
  | { kind: "blocked"; messages: string[] };

export type PlanValidationContext = {
  discoveryCapabilities: string[];
  siteConfigPublishRequiresApproval: boolean;
};

function hasCap(caps: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return caps.some((c) => c.toLowerCase().includes(n));
}

function isPlaceholderOpenQuestion(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return (
    normalized === "none" ||
    normalized === "none." ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "no open questions" ||
    normalized === "no open questions." ||
    normalized === "no questions" ||
    normalized === "no questions."
  );
}

function findNumericPostId(input: Record<string, unknown>): number | undefined {
  const candidates = [input["post_id"], input["postId"], input["id"]];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickString(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return undefined;
}

function canResolveActionViaPostLookup(
  actionType: string,
  input: Record<string, unknown>
): boolean {
  const t = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  const supportsLookup =
    t === "update_post" ||
    t === "update_post_fields" ||
    t === "update_post_content" ||
    t === "edit_post_fields" ||
    t === "sitepilot_update_post_fields" ||
    t === "set_post_seo_meta" ||
    t === "sitepilot_set_post_seo_meta" ||
    t === "set_featured_image" ||
    t === "set_post_featured_image" ||
    t === "update_post_featured_image" ||
    t === "sitepilot_set_post_featured_image";

  if (!supportsLookup || findNumericPostId(input) !== undefined) {
    return false;
  }

  return (
    pickString(
      input,
      "lookup_post_type",
      "lookupPostType",
      "target_post_type",
      "targetPostType",
      "post_type",
      "postType"
    ) !== undefined ||
    pickString(
      input,
      "lookup_status",
      "lookupStatus",
      "target_status",
      "targetStatus",
      "post_status",
      "postStatus",
      "status"
    ) !== undefined ||
    pickString(
      input,
      "lookup_slug",
      "lookupSlug",
      "target_slug",
      "targetSlug",
      "post_name",
      "postSlug",
      "slug"
    ) !== undefined ||
    pickString(
      input,
      "lookup_title",
      "lookupTitle",
      "target_title",
      "targetTitle",
      "existing_title",
      "existingTitle"
    ) !== undefined ||
    pickString(
      input,
      "lookup_search",
      "lookupSearch",
      "target_search",
      "targetSearch",
      "search",
      "query"
    ) !== undefined
  );
}

function actionCreatesDraftPost(actionType: string): boolean {
  const t = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  return (
    t === "create_draft_post" ||
    t === "create_draft_content" ||
    t === "create_post_draft" ||
    t === "sitepilot_create_draft_post"
  );
}

function canResolveActionViaEarlierCreate(
  plan: ActionPlan,
  actionIndex: number
): boolean {
  const priorCreates = plan.proposedActions
    .slice(0, actionIndex)
    .filter((action) => actionCreatesDraftPost(action.type));

  return priorCreates.length === 1;
}

/**
 * Deterministic policy and capability checks for a schema-valid plan (T25).
 */
export function validateActionPlan(
  plan: ActionPlan,
  ctx: PlanValidationContext
): PlanValidationOutcome {
  const blocked: string[] = [];
  const clarification: string[] = [];

  for (const [actionIndex, action] of plan.proposedActions.entries()) {
    const t = action.type
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[\s/_-]+/g, "_")
      .toLowerCase();
    if (
      t.includes("publish") &&
      !hasCap(ctx.discoveryCapabilities, "publish")
    ) {
      blocked.push(
        `Action "${action.type}" implies publishing, but discovery capabilities do not list publish access.`
      );
    }

    if (
      (t === "update_post" ||
        t.includes("update_post_fields") ||
        t.includes("update_post_content") ||
        t.includes("edit_post_fields") ||
        t.includes("set_post_seo_meta") ||
        t.includes("set_post_featured_image") ||
        t === "set_featured_image" ||
        t === "update_post_featured_image") &&
      findNumericPostId(action.input) === undefined &&
      !canResolveActionViaPostLookup(action.type, action.input) &&
      !canResolveActionViaEarlierCreate(plan, actionIndex)
    ) {
      clarification.push(
        `Action "${action.type}" is missing the target post id. Ask which page or post should be updated before execution.`
      );
    }
  }

  if (blocked.length > 0) {
    return { kind: "blocked", messages: blocked };
  }

  if (clarification.length > 0) {
    return { kind: "blocked_clarification", messages: clarification };
  }

  const unresolvedOpenQuestions = plan.openQuestions.filter(
    (question) => !isPlaceholderOpenQuestion(question)
  );

  if (unresolvedOpenQuestions.length > 0) {
    return {
      kind: "blocked_clarification",
      messages: [
        "Plan still lists open questions — resolve them before execution.",
        ...unresolvedOpenQuestions
      ]
    };
  }

  const needsApproval =
    plan.approvalRequired ||
    plan.riskLevel === "high" ||
    plan.riskLevel === "critical" ||
    plan.proposedActions.some(
      (a) => a.riskLevel === "high" || a.riskLevel === "critical"
    ) ||
    (ctx.siteConfigPublishRequiresApproval &&
      plan.proposedActions.some((a) =>
        a.type.toLowerCase().includes("publish")
      ));

  if (needsApproval) {
    return {
      kind: "blocked_approval",
      messages: ["This plan must go through an approval gate before execution."]
    };
  }

  const messages: string[] = [...plan.validationWarnings];

  if (plan.riskLevel === "medium") {
    messages.push("Plan risk is medium — review carefully before execution.");
  }

  if (messages.length > 0) {
    return { kind: "warnings", messages };
  }

  return { kind: "pass" };
}
