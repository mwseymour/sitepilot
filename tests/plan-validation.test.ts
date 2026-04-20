import { describe, expect, it } from "vitest";

import { actionPlanSchema } from "@sitepilot/contracts";
import { validateActionPlan } from "@sitepilot/validation";

const basePlan = actionPlanSchema.parse({
  id: "plan-1",
  requestId: "req-1",
  siteId: "site-1",
  requestSummary: "Update hero",
  assumptions: [],
  openQuestions: [],
  targetEntities: [],
  proposedActions: [
    {
      id: "act-1",
      type: "edit_post_draft",
      version: 1,
      input: {},
      targetEntityRefs: ["post:1"],
      permissionRequirement: "draft_edit",
      riskLevel: "low",
      dryRunCapable: true,
      rollbackSupported: true
    }
  ],
  dependencies: [],
  approvalRequired: false,
  riskLevel: "low",
  rollbackNotes: [],
  validationWarnings: [],
  createdAt: "2026-04-20T12:00:00.000Z",
  updatedAt: "2026-04-20T12:00:00.000Z"
});

describe("validateActionPlan (T25)", () => {
  it("passes for a low-risk draft edit when capabilities allow", () => {
    const outcome = validateActionPlan(basePlan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("pass");
  });

  it("blocks when a publish action lacks publish capability", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      proposedActions: [
        {
          ...basePlan.proposedActions[0]!,
          type: "publish_post"
        }
      ]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("blocked");
  });

  it("returns blocked_clarification when open questions remain", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      openQuestions: ["Which page should change?"]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("blocked_clarification");
  });

  it("returns blocked_approval when plan requires approval", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      approvalRequired: true
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "publish"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("blocked_approval");
  });

  it("returns blocked_clarification when an update action lacks post_id", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      proposedActions: [
        {
          ...basePlan.proposedActions[0]!,
          type: "sitepilot-update-post-fields",
          input: { content: "Fresh body" }
        }
      ]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("blocked_clarification");
  });

  it("passes when an update action can resolve its target via lookup fields", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      proposedActions: [
        {
          ...basePlan.proposedActions[0]!,
          type: "sitepilot-update-post-fields",
          input: {
            content: "Fresh body",
            lookup_status: "draft",
            lookup_post_type: "post"
          }
        }
      ]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("pass");
  });
});
