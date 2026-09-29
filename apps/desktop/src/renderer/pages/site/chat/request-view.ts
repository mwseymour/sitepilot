import {
  requestNeedsVisualAnalysisReview,
  requestVisualAnalysisIsCurrent
} from "@sitepilot/services/request-visual-analysis";

import {
  resolveRequestNextAction,
  type RequestNextAction
} from "../../../chat-workflow.js";
import type { GutenbergV2UiState } from "../GutenbergV2CandidatePanel.js";
import { requestExecutionControlsLocked } from "./plan-actions.js";
import type { RequestBundleOk, RequestWorkflow } from "./types.js";

export type ComposerCopy = {
  title: string;
  helper: string;
  placeholder: string;
  actionLabel: string;
};

export function composerCopy({
  isConversationMode,
  bundle,
  requestWorkflow
}: {
  isConversationMode: boolean;
  bundle: RequestBundleOk | null;
  requestWorkflow: RequestWorkflow;
}): ComposerCopy {
  if (isConversationMode) {
    return {
      title: "Conversation",
      helper:
        "Read-only. Conversations never change the site.",
      placeholder:
        "Ask about site content, or paste a link and ask to use it in a new Request…",
      actionLabel: "Send"
    };
  }

  if (!bundle) {
    return {
      title: "New request",
      helper:
        requestWorkflow === "gutenberg_v2"
          ? "Nothing is saved until you approve."
          : "Start with what you want changed on the site. SitePilot will ask follow-up questions if it needs more detail.",
      placeholder: "Ask SitePilot to create, edit, or analyse something…",
      actionLabel: "Send"
    };
  }

  switch (bundle.request.status) {
    case "clarifying":
      return {
        title: "Answer question",
        helper:
          "Your answer keeps the same request moving.",
        placeholder: "Answer the assistant's question…",
        actionLabel: "Reply"
      };
    case "new":
    case "drafted":
      return {
        title: "Refine request",
        helper:
          requestWorkflow === "gutenberg_v2"
            ? "Replying rebuilds the update for review."
            : "Add detail only if the request is incomplete. When it is ready, generate a plan.",
        placeholder: "Add more detail to the current request…",
        actionLabel: "Update request"
      };
    case "awaiting_approval":
      return {
        title: "Change this request",
        helper:
          "Replying rebuilds the update for review.",
        placeholder: "Describe the change, and attach images if you need to…",
        actionLabel: "Update request"
      };
    case "approved":
      return {
        title: "Change this request",
        helper:
          requestWorkflow === "gutenberg_v2"
            ? "Replying withdraws the approval."
            : "Run the plan in the request panel, or reply here to change the same request. You can attach images.",
        placeholder: "Describe how this request should change…",
        actionLabel: "Update request"
      };
    case "executing":
      return {
        title: "Add note",
        helper:
          "SitePilot reads notes once this run finishes.",
        placeholder: "Add a note for this request…",
        actionLabel: "Add note"
      };
    default:
      return {
        title: "New request",
        helper:
          "The last request is closed. Sending starts a new one.",
        placeholder: "Ask SitePilot to do the next thing…",
        actionLabel: "Send"
      };
  }
}

export type RequestView = {
  canGeneratePlan: boolean;
  visualAnalysisRequired: boolean;
  visualAnalysisReadyForPlanning: boolean;
  visualAnalysisStale: boolean;
  isV2Workflow: boolean;
  canGeneratePlanNow: boolean;
  executionControlsLocked: boolean;
  requestNextAction: RequestNextAction | null;
  composerWorkflowIsSecondary: boolean;
  showInChatApprove: boolean;
};

export function deriveRequestView({
  isConversationMode,
  selectedThreadId,
  bundle,
  gutenbergV2State,
  requestWorkflow,
  canRunPlanDirectly,
  openQuestionCount
}: {
  isConversationMode: boolean;
  selectedThreadId: string | null;
  bundle: RequestBundleOk | null;
  gutenbergV2State: GutenbergV2UiState | null;
  requestWorkflow: RequestWorkflow;
  canRunPlanDirectly: boolean;
  openQuestionCount: number;
}): RequestView {
  const canGeneratePlan =
    !isConversationMode &&
    selectedThreadId !== null &&
    bundle !== null &&
    (bundle.request.status === "new" ||
      bundle.request.status === "drafted" ||
      bundle.request.status === "approved" ||
      bundle.request.status === "awaiting_approval");
  const visualAnalysisRequired =
    bundle !== null &&
    requestNeedsVisualAnalysisReview({
      userPrompt: bundle.request.userPrompt,
      attachments: bundle.request.attachments
    });
  const visualAnalysisReadyForPlanning =
    bundle !== null &&
    (!visualAnalysisRequired ||
      requestVisualAnalysisIsCurrent(
        bundle.request.updatedAt,
        bundle.visualAnalysis
      ));
  const visualAnalysisStale =
    bundle !== null &&
    bundle.visualAnalysis !== null &&
    bundle.visualAnalysis.analyzedRequestUpdatedAt < bundle.request.updatedAt;
  // The v2 candidate panel owns review, approval and execution for its
  // request; v1's next-step card and analysis controls would duplicate them.
  const isV2Request =
    bundle !== null &&
    gutenbergV2State !== null &&
    gutenbergV2State.requestId === bundle.request.id;
  const isV2Workflow = requestWorkflow === "gutenberg_v2" || isV2Request;
  const canGeneratePlanNow =
    canGeneratePlan &&
    visualAnalysisReadyForPlanning &&
    gutenbergV2State === null;
  const executionControlsLocked =
    (bundle !== null &&
      requestExecutionControlsLocked(bundle.request.status)) ||
    gutenbergV2State !== null;
  const requestNextAction =
    bundle !== null && !isConversationMode
      ? resolveRequestNextAction({
          requestStatus: bundle.request.status,
          hasPlan: bundle.plan !== null && bundle.plan !== undefined,
          pendingApproval: bundle.pendingApproval !== null,
          canRunPlanDirectly,
          visualAnalysisRequired,
          visualAnalysisReady:
            !visualAnalysisRequired ||
            (bundle.visualAnalysis !== null && !visualAnalysisStale),
          visualAnalysisNeedsReview:
            visualAnalysisRequired &&
            bundle.visualAnalysis !== null &&
            !visualAnalysisStale &&
            bundle.visualAnalysis.reviewedAt === undefined,
          gutenbergV2Enabled: true,
          requestWorkflow,
          gutenbergV2State: gutenbergV2State?.state ?? null,
          openQuestionCount,
          executionLocked:
            bundle !== null &&
            requestExecutionControlsLocked(bundle.request.status)
        })
      : null;
  const composerWorkflowIsSecondary =
    requestNextAction?.primary?.id === "generate_plan" ||
    requestNextAction?.primary?.id === "approve_plan" ||
    requestNextAction?.primary?.id === "run_plan";
  const showInChatApprove =
    requestNextAction?.primary?.id === "approve_plan" &&
    bundle?.pendingApproval !== null;

  return {
    canGeneratePlan,
    visualAnalysisRequired,
    visualAnalysisReadyForPlanning,
    visualAnalysisStale,
    isV2Workflow,
    canGeneratePlanNow,
    executionControlsLocked,
    requestNextAction,
    composerWorkflowIsSecondary,
    showInChatApprove
  };
}
