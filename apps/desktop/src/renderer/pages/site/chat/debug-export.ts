import type { ImageAttachmentPayload } from "@sitepilot/contracts";

import type { SiteWorkspaceContextValue } from "../../../site-workspace/site-workspace-context.js";
import { summarizeImageAttachment } from "./attachments.js";
import { parseJsonDebugValue } from "./message-format.js";
import type {
  DryRunPreview,
  MessageRow,
  RequestBundleOk,
  ThreadRow
} from "./types.js";

type WorkspaceData = NonNullable<SiteWorkspaceContextValue["data"]>;

export type DebugExportInput = {
  siteId: string;
  data: WorkspaceData;
  selectedThreadId: string | null;
  lastRequestId: string | null;
  developerToolsEnabled: boolean;
  preserveOriginalImageUploads: boolean;
  busy: boolean;
  execBusy: boolean;
  activityLabel: string | null;
  execProgressLabel: string | null;
  lastExecHint: string | null;
  err: string | null;
  threads: ThreadRow[];
  selectedThread: ThreadRow | undefined;
  messages: MessageRow[];
  requestPrompt: string;
  pendingAttachments: ImageAttachmentPayload[];
  developerMessages: string[];
  bundle: RequestBundleOk | null;
  planValidationJson: string | null;
  plannerJson: string | null;
  dryRunPreview: DryRunPreview | null;
};

// Key order is kept stable so copied logs diff cleanly between sessions.
export function buildDebugExport({
  siteId,
  data,
  selectedThreadId,
  lastRequestId,
  developerToolsEnabled,
  preserveOriginalImageUploads,
  busy,
  execBusy,
  activityLabel,
  execProgressLabel,
  lastExecHint,
  err,
  threads,
  selectedThread,
  messages,
  requestPrompt,
  pendingAttachments,
  developerMessages,
  bundle,
  planValidationJson,
  plannerJson,
  dryRunPreview
}: DebugExportInput) {
  return {
    exportedAt: new Date().toISOString(),
    siteId,
    site: {
      id: data.site.id,
      name: data.site.name,
      activationStatus: data.site.activationStatus,
      workspaceId: data.site.workspaceId,
      environment: data.site.environment,
      baseUrl: data.site.baseUrl
    },
    uiState: {
      selectedThreadId,
      lastRequestId,
      developerToolsEnabled,
      preserveOriginalImageUploads,
      busy,
      execBusy,
      activityLabel,
      execProgressLabel,
      lastExecHint,
      error: err
    },
    threadList: threads,
    selectedThread: selectedThread ?? null,
    messages: messages.map((message) => ({
      ...message,
      attachments:
        message.attachments?.map((attachment) =>
          summarizeImageAttachment(attachment)
        ) ?? []
    })),
    currentRequestPromptDraft: requestPrompt,
    pendingAttachments: pendingAttachments.map((attachment) =>
      summarizeImageAttachment(attachment)
    ),
    debugPanels: {
      feedbackLog: developerMessages,
      currentRequestPrompt: bundle?.request.userPrompt ?? null,
      visualAnalysis: bundle?.visualAnalysis ?? null,
      planValidation: parseJsonDebugValue(planValidationJson),
      plannedActions: bundle?.plan?.proposedActions ?? null,
      lastMcpRequest: bundle?.lastExecution?.toolInvocation
        ? {
            toolName: bundle.lastExecution.toolInvocation.toolName,
            input: bundle.lastExecution.toolInvocation.input
          }
        : null,
      lastMcpResponse: bundle?.lastExecution?.toolInvocation?.output ?? null,
      plannerContext: parseJsonDebugValue(plannerJson),
      dryRunPreview
    },
    bundle,
    workspaceData: data
  };
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const succeeded = document.execCommand("copy");
  textarea.remove();
  if (!succeeded) {
    throw new Error("Clipboard copy is not available in this environment.");
  }
}
