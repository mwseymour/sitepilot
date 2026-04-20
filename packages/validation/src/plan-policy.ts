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

function hasNumericPostId(input: Record<string, unknown>): boolean {
  const candidates = [input["post_id"], input["postId"], input["id"]];
  return candidates.some((value) => {
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      return !Number.isNaN(parsed) && parsed > 0;
    }
    return false;
  });
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

  for (const action of plan.proposedActions) {
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
      (t.includes("update_post_fields") ||
        t.includes("update_post_content") ||
        t.includes("edit_post_fields") ||
        t.includes("set_post_seo_meta")) &&
      !hasNumericPostId(action.input)
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

  if (plan.openQuestions.length > 0) {
    return {
      kind: "blocked_clarification",
      messages: [
        "Plan still lists open questions — resolve them before execution.",
        ...plan.openQuestions
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
