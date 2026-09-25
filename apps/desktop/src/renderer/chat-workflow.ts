export type ChatMode = "request" | "conversation";

export type RequestNextActionId =
  | "reply"
  | "analyze_reference"
  | "approve_analysis"
  | "generate_plan"
  | "approve_plan"
  | "run_plan"
  | "generate_candidate"
  | "approve_candidate"
  | "apply_update"
  | "none";

export type RequestNextAction = {
  statusLabel: string;
  title: string;
  helper: string;
  primary: { id: RequestNextActionId; label: string } | null;
  secondary: { id: RequestNextActionId; label: string }[];
};

const HUMAN_STATUS: Record<string, string> = {
  clarifying: "Waiting for your answer",
  new: "Ready to plan",
  drafted: "Ready to plan",
  awaiting_approval: "Needs approval",
  approved: "Ready to run",
  executing: "Running on the site",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled"
};

export function humanRequestStatus(status: string): string {
  if (status in HUMAN_STATUS) {
    return HUMAN_STATUS[status]!;
  }
  return status
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function modePageCopy(mode: ChatMode): {
  navHint: string;
  pageLede: string;
  emptyState: string;
  otherModeLabel: string;
  otherModePathSegment: "chat" | "conversations";
} {
  if (mode === "conversation") {
    return {
      navHint: "Research only",
      pageLede:
        "Conversations are research-only. They do not generate plans or change the site. Start a Request when you want something applied.",
      emptyState:
        "Start a conversation to look up content or gather source material. When you are ready to change the site, open Requests.",
      otherModeLabel: "Open Requests",
      otherModePathSegment: "chat"
    };
  }
  return {
    navHint: "Make site changes",
    pageLede:
      "A request becomes a plan you generate, approve, and run. Use Conversations only when you need to look something up first.",
    emptyState:
      "Create a request, describe the change, then generate a plan. Conversations will not change the site.",
    otherModeLabel: "Open Conversations",
    otherModePathSegment: "conversations"
  };
}

export function resolveRequestNextAction(input: {
  requestStatus: string;
  hasPlan: boolean;
  pendingApproval: boolean;
  canRunPlanDirectly: boolean;
  visualAnalysisRequired: boolean;
  visualAnalysisReady: boolean;
  visualAnalysisNeedsReview: boolean;
  gutenbergV2Enabled: boolean;
  requestWorkflow: "legacy" | "gutenberg_v2";
  gutenbergV2State: string | null;
  openQuestionCount: number;
  executionLocked: boolean;
}): RequestNextAction {
  const statusLabel = humanRequestStatus(input.requestStatus);

  if (input.requestStatus === "clarifying") {
    return {
      statusLabel,
      title: "Answer the clarification question",
      helper: "Answer the question in the composer below to keep this request moving.",
      primary: { id: "reply", label: "Reply in the composer" },
      secondary: []
    };
  }

  if (input.hasPlan && input.openQuestionCount > 0) {
    return {
      statusLabel,
      title: "Answer plan questions",
      helper: "Reply in the composer with answers so the plan can run without ambiguity.",
      primary: { id: "reply", label: "Answer questions" },
      secondary: []
    };
  }

  if (input.visualAnalysisRequired && !input.visualAnalysisReady) {
    return {
      statusLabel,
      title: "Analyze the reference",
      helper: "Next: analyze the uploaded reference before generating a plan.",
      primary: { id: "analyze_reference", label: "Analyze reference" },
      secondary: []
    };
  }

  if (
    input.visualAnalysisRequired &&
    input.visualAnalysisReady &&
    input.visualAnalysisNeedsReview
  ) {
    return {
      statusLabel,
      title: "Approve reference analysis",
      helper: "Next: review and approve the reference analysis before planning.",
      primary: { id: "approve_analysis", label: "Approve analysis" },
      secondary: []
    };
  }

  if (
    input.gutenbergV2Enabled &&
    input.requestWorkflow === "gutenberg_v2"
  ) {
    if (input.gutenbergV2State === "review_ready") {
      return {
        statusLabel,
        title: "Review this update",
        helper: "Next: approve this update when it looks right.",
        primary: { id: "approve_candidate", label: "Approve this update" },
        secondary: []
      };
    }
    if (input.gutenbergV2State === "approved") {
      return {
        statusLabel,
        title: "Apply this update",
        helper: "Next: apply the approved update to the site.",
        primary: {
          id: "apply_update",
          label: "Apply this update to the site"
        },
        secondary: []
      };
    }
    if (
      input.gutenbergV2State === null &&
      (input.requestStatus === "new" || input.requestStatus === "drafted")
    ) {
      return {
        statusLabel,
        title: "Generate a site update",
        helper:
          "Next: generate an update from this request. Add detail in the composer only if something is missing.",
        primary: { id: "generate_candidate", label: "Generate update" },
        secondary: []
      };
    }
  }

  if (
    input.requestStatus === "awaiting_approval" ||
    input.pendingApproval
  ) {
    return {
      statusLabel,
      title: "Approve the plan",
      helper: "Next: approve this plan in the request panel, or regenerate it if it needs changes.",
      primary: { id: "approve_plan", label: "Approve plan" },
      secondary: [{ id: "generate_plan", label: "Regenerate plan" }]
    };
  }

  if (
    input.requestStatus === "new" ||
    input.requestStatus === "drafted"
  ) {
    return {
      statusLabel,
      title: "Generate a plan",
      helper:
        "Next: generate a plan. Do not send another chat message unless you need to add detail.",
      primary: { id: "generate_plan", label: "Generate plan" },
      secondary: []
    };
  }

  if (
    input.requestStatus === "approved" &&
    input.hasPlan &&
    input.canRunPlanDirectly &&
    !input.executionLocked
  ) {
    return {
      statusLabel,
      title: "Run the plan",
      helper: "Next: run this plan on the site.",
      primary: { id: "run_plan", label: "Run plan" },
      secondary: []
    };
  }

  if (
    (input.requestStatus === "approved" ||
      input.requestStatus === "completed") &&
    input.executionLocked
  ) {
    return {
      statusLabel,
      title: "Plan already ran",
      helper:
        "This plan already ran. Start a new request for another change.",
      primary: null,
      secondary: []
    };
  }

  return {
    statusLabel,
    title: "No action required",
    helper: "Continue in the composer if you need to add more detail.",
    primary: null,
    secondary: []
  };
}
