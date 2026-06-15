import { describe, expect, it } from "vitest";

import { actionPlanSchema } from "@sitepilot/contracts";
import { validateActionPlan } from "../packages/validation/src/plan-policy.ts";

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
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
    });
    expect(outcome.kind).toBe("pass");
  });

  it("returns blocked_approval for low-risk draft edits when auto-approval is not allowed", () => {
    const outcome = validateActionPlan(basePlan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: []
    });
    expect(outcome.kind).toBe("blocked_approval");
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
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: []
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
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: []
    });
    expect(outcome.kind).toBe("blocked_clarification");
  });

  it("ignores placeholder open questions like 'None.'", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      openQuestions: ["None."]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
    });
    expect(outcome.kind).toBe("pass");
  });

  it("returns blocked_approval when plan requires approval", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      approvalRequired: true
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "publish"],
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
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
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
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
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
    });
    expect(outcome.kind).toBe("pass");
  });

  it("returns warnings when an insertion-style request still looks like a full replacement", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      requestSummary: "Edit the post called Hello Ben and add a heading at the end",
      proposedActions: [
        {
          ...basePlan.proposedActions[0]!,
          type: "sitepilot-update-post-fields",
          input: {
            lookup_title: "Hello Ben",
            lookup_post_type: "post",
            lookup_status: "draft",
            content: '<!-- wp:heading --><h2>Hello Beth</h2><!-- /wp:heading -->'
          }
        }
      ]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
    });
    expect(outcome.kind).toBe("warnings");
    expect(outcome.messages).toContain(
      'Action "sitepilot-update-post-fields" looks like a full content replacement, but the request summary describes an insertion/edit-in-place. Regenerate or rewrite the plan to use insert_position/insert_after_*/insert_before_* unless full replacement was explicitly requested.'
    );
  });

  it("passes when SEO metadata targets a post created earlier in the same plan", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      proposedActions: [
        {
          id: "act-create",
          type: "create_draft_post",
          version: 1,
          input: { title: "New Post", post_type: "post" },
          targetEntityRefs: [],
          permissionRequirement: "edit_posts",
          riskLevel: "low",
          dryRunCapable: true,
          rollbackSupported: true
        },
        {
          id: "act-seo",
          type: "sitepilot-set-post-seo-meta",
          version: 1,
          input: { metaDescription: "wibble" },
          targetEntityRefs: [],
          permissionRequirement: "edit_posts",
          riskLevel: "low",
          dryRunCapable: false,
          rollbackSupported: false
        }
      ]
    });
    const outcome = validateActionPlan(plan, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false,
      siteConfigAutoApproveCategories: ["draft_content_update"]
    });
    expect(outcome.kind).toBe("pass");
  });
});
