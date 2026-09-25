import { describe, expect, it } from "vitest";

import {
  humanRequestStatus,
  modePageCopy,
  resolveRequestNextAction
} from "../apps/desktop/src/renderer/chat-workflow.js";

const defaults = {
  hasPlan: false,
  pendingApproval: false,
  canRunPlanDirectly: true,
  visualAnalysisRequired: false,
  visualAnalysisReady: false,
  visualAnalysisNeedsReview: false,
  gutenbergV2Enabled: false,
  requestWorkflow: "legacy" as const,
  gutenbergV2State: null as string | null,
  openQuestionCount: 0,
  executionLocked: false
};

describe("humanRequestStatus", () => {
  it("maps known request statuses", () => {
    expect(humanRequestStatus("clarifying")).toBe("Waiting for your answer");
    expect(humanRequestStatus("new")).toBe("Ready to plan");
    expect(humanRequestStatus("drafted")).toBe("Ready to plan");
    expect(humanRequestStatus("awaiting_approval")).toBe("Needs approval");
    expect(humanRequestStatus("approved")).toBe("Ready to run");
    expect(humanRequestStatus("executing")).toBe("Running on the site");
    expect(humanRequestStatus("completed")).toBe("Done");
    expect(humanRequestStatus("failed")).toBe("Failed");
    expect(humanRequestStatus("cancelled")).toBe("Cancelled");
  });

  it("title-cases unknown statuses", () => {
    expect(humanRequestStatus("awaiting_review")).toBe("Awaiting Review");
  });
});

describe("modePageCopy", () => {
  it("returns request mode copy", () => {
    expect(modePageCopy("request")).toEqual({
      navHint: "Make site changes",
      pageLede:
        "A request builds the change in this site’s WordPress editor for you to review, approve and apply. Use Conversations only when you need to look something up first.",
      emptyState:
        "Create a request and describe the change. You review a preview before anything is saved. Conversations will not change the site.",
      otherModeLabel: "Open Conversations",
      otherModePathSegment: "conversations"
    });
  });

  it("returns conversation mode copy", () => {
    expect(modePageCopy("conversation")).toEqual({
      navHint: "Research only",
      pageLede:
        "Conversations are research-only. They do not generate plans or change the site. Start a Request when you want something applied.",
      emptyState:
        "Start a conversation to look up content or gather source material. When you are ready to change the site, open Requests.",
      otherModeLabel: "Open Requests",
      otherModePathSegment: "chat"
    });
  });
});

describe("resolveRequestNextAction", () => {
  it("clarifying prompts a composer reply", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "clarifying"
    });
    expect(action.statusLabel).toBe("Waiting for your answer");
    expect(action.primary).toEqual({
      id: "reply",
      label: "Reply in the composer"
    });
    expect(action.helper.toLowerCase()).toContain("composer");
  });

  it("new or drafted without visual analysis offers generate plan", () => {
    for (const requestStatus of ["new", "drafted"] as const) {
      const action = resolveRequestNextAction({
        ...defaults,
        requestStatus
      });
      expect(action.primary).toEqual({
        id: "generate_plan",
        label: "Generate plan"
      });
      expect(action.helper).toBe(
        "Next: generate a plan. Do not send another chat message unless you need to add detail."
      );
    }
  });

  it("requires reference analysis before planning", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "new",
      visualAnalysisRequired: true,
      visualAnalysisReady: false
    });
    expect(action.primary).toEqual({
      id: "analyze_reference",
      label: "Analyze reference"
    });
  });

  it("requires approving visual analysis when review is pending", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "new",
      visualAnalysisRequired: true,
      visualAnalysisReady: true,
      visualAnalysisNeedsReview: true
    });
    expect(action.primary).toEqual({
      id: "approve_analysis",
      label: "Approve analysis"
    });
  });

  it("awaiting approval offers approve plan with regenerate secondary", () => {
    const awaiting = resolveRequestNextAction({
      ...defaults,
      requestStatus: "awaiting_approval",
      hasPlan: true
    });
    expect(awaiting.primary).toEqual({
      id: "approve_plan",
      label: "Approve plan"
    });
    expect(awaiting.secondary).toContainEqual({
      id: "generate_plan",
      label: "Regenerate plan"
    });

    const pending = resolveRequestNextAction({
      ...defaults,
      requestStatus: "approved",
      pendingApproval: true,
      hasPlan: true
    });
    expect(pending.primary?.id).toBe("approve_plan");
  });

  it("approved plan ready to run when unlocked", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "approved",
      hasPlan: true,
      canRunPlanDirectly: true,
      executionLocked: false
    });
    expect(action.primary).toEqual({ id: "run_plan", label: "Run plan" });
    expect(action.helper).toBe("Next: run this plan on the site.");
  });

  it("blocks rerun when execution is locked", () => {
    for (const requestStatus of ["approved", "completed"] as const) {
      const action = resolveRequestNextAction({
        ...defaults,
        requestStatus,
        hasPlan: true,
        executionLocked: true
      });
      expect(action.primary).toBeNull();
      expect(action.helper).toBe(
        "This plan already ran. Start a new request for another change."
      );
    }
  });

  it("gutenberg v2 new request generates an update candidate", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "new",
      gutenbergV2Enabled: true,
      requestWorkflow: "gutenberg_v2",
      gutenbergV2State: null
    });
    expect(action.primary).toEqual({
      id: "generate_candidate",
      label: "Generate update"
    });
  });

  it("gutenberg v2 review_ready approves the candidate", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "drafted",
      gutenbergV2Enabled: true,
      requestWorkflow: "gutenberg_v2",
      gutenbergV2State: "review_ready"
    });
    expect(action.primary).toEqual({
      id: "approve_candidate",
      label: "Approve this update"
    });
  });

  it("gutenberg v2 approved applies the update", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "approved",
      gutenbergV2Enabled: true,
      requestWorkflow: "gutenberg_v2",
      gutenbergV2State: "approved"
    });
    expect(action.primary).toEqual({
      id: "apply_update",
      label: "Apply this update to the site"
    });
  });

  it("open plan questions take priority over run or generate", () => {
    const action = resolveRequestNextAction({
      ...defaults,
      requestStatus: "approved",
      hasPlan: true,
      openQuestionCount: 2,
      canRunPlanDirectly: true
    });
    expect(action.primary).toEqual({
      id: "reply",
      label: "Answer questions"
    });
    expect(action.primary?.id).not.toBe("run_plan");
    expect(action.primary?.id).not.toBe("generate_plan");
  });
});
