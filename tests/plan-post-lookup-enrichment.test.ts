import { describe, expect, it } from "vitest";

import { actionPlanSchema, type PlannerContext } from "@sitepilot/contracts";
import {
  canResolveActionViaPostLookup,
  enrichActionPlanWithPostLookupFromContext,
  inferPostLookupHintsFromCorpus
} from "@sitepilot/services";
import { validateActionPlan } from "@sitepilot/validation";

describe("inferPostLookupHintsFromCorpus", () => {
  it("extracts title and draft status from common phrasing", () => {
    expect(
      inferPostLookupHintsFromCorpus(
        "Find the draft post called Hello Matt and update that one."
      )
    ).toEqual({
      lookup_title: "Hello Matt",
      lookup_status: "draft"
    });
  });

  it("handles post titled without quotes", () => {
    expect(
      inferPostLookupHintsFromCorpus(
        "Lookup the post_id - its a post titled Hello Matt"
      )
    ).toEqual({ lookup_title: "Hello Matt" });
  });

  it("extracts quoted title", () => {
    expect(
      inferPostLookupHintsFromCorpus(`Draft post called "Hello Matt" please edit`)
    ).toEqual({
      lookup_title: "Hello Matt",
      lookup_status: "draft"
    });
  });
});

describe("enrichActionPlanWithPostLookupFromContext", () => {
  const basePlan = actionPlanSchema.parse({
    id: "plan-1",
    requestId: "req-1",
    siteId: "site-1",
    requestSummary: "Update post body",
    assumptions: [],
    openQuestions: [],
    targetEntities: [],
    proposedActions: [
      {
        id: "act-1",
        type: "update-post-fields",
        version: 1,
        input: { content: "<p>Hi</p>" },
        targetEntityRefs: [],
        permissionRequirement: "edit_posts",
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

  const context: PlannerContext = {
    siteId: "site-1",
    threadId: "thr-1",
    builtAt: "2026-04-20T12:00:00.000Z",
    siteConfig: null,
    discoverySummary: null,
    messages: [
      {
        messageId: "m-1",
        role: "user",
        format: "plain_text",
        text: "Find the draft post called Hello Matt and update the content.",
        createdAt: "2026-04-20T12:00:00.000Z",
        requestId: "req-1"
      }
    ],
    targetSummaries: [],
    priorChanges: []
  };

  it("adds lookup fields so validation can treat the action as resolvable", () => {
    const enriched = enrichActionPlanWithPostLookupFromContext(
      basePlan,
      context
    );
    const input = enriched.proposedActions[0]!.input as Record<
      string,
      unknown
    >;
    expect(input.lookup_title).toBe("Hello Matt");
    expect(input.lookup_status).toBe("draft");
    expect(
      canResolveActionViaPostLookup(enriched.proposedActions[0]!.type, input)
    ).toBe(true);
  });

  it("passes plan validation after enrichment", () => {
    const enriched = enrichActionPlanWithPostLookupFromContext(
      basePlan,
      context
    );
    const outcome = validateActionPlan(enriched, {
      discoveryCapabilities: ["read", "edit_drafts"],
      siteConfigPublishRequiresApproval: false
    });
    expect(outcome.kind).toBe("pass");
  });
});
