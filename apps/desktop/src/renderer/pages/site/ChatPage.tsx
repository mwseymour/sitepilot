import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import { Link } from "react-router-dom";

import type {
  ChatMessagePayload,
  ChatThreadPayload,
  ImageAttachmentPayload,
  SitePilotDesktopApi,
  UiPreferences
} from "@sitepilot/contracts";
import { actionToMcpToolCall } from "@sitepilot/services/mcp-action-map";
import {
  canResolveActionViaPostLookup,
  findNumericPostId
} from "@sitepilot/services/post-target-resolution";
import {
  requestNeedsVisualAnalysisReview,
  requestVisualAnalysisIsCurrent
} from "@sitepilot/services/request-visual-analysis";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

type ThreadRow = ChatThreadPayload;
type MessageRow = ChatMessagePayload;

type RequestBundleOk = Extract<
  Awaited<ReturnType<SitePilotDesktopApi["getRequestBundle"]>>,
  { ok: true }
>;
type ExecutePlanActionOk = Extract<
  Awaited<ReturnType<SitePilotDesktopApi["executePlanAction"]>>,
  { ok: true }
>;

type DryRunPreview = {
  actionId: string;
  actionType: string;
  toolName?: string;
  requestInput?: Record<string, unknown>;
  mcpResult: ExecutePlanActionOk["mcpResult"];
};

const SHOW_DRY_RUN_UI = true;
const MAX_IMAGE_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1280;
const IMAGE_JPEG_QUALITY = 0.82;

type ChatMode = "request" | "conversation";

type ThreadTypeMeta = {
  label: string;
  description: string;
};

const THREAD_TYPE_META: Record<string, ThreadTypeMeta> = {
  conversation: {
    label: "Conversation",
    description:
      "Research and read-only chat. Use it for site lookups or external source intake before creating a Request."
  },
  general_request: {
    label: "Standard request",
    description: "Default planning and execution workflow for site changes."
  },
  content_creation: {
    label: "Content creation",
    description: "Create new draft content."
  },
  content_update: {
    label: "Content update",
    description: "Revise existing posts or pages."
  },
  media_request: {
    label: "Media request",
    description: "Image and media-related changes."
  },
  seo_request: {
    label: "SEO request",
    description: "SEO metadata and search visibility changes."
  },
  taxonomy_request: {
    label: "Taxonomy request",
    description: "Category, tag, and taxonomy changes."
  },
  publish_request: {
    label: "Publish request",
    description: "Publishing and go-live tasks."
  },
  maintenance_diagnostic: {
    label: "Maintenance diagnostic",
    description: "Read-only inspection or maintenance work."
  },
  approval_discussion: {
    label: "Approval discussion",
    description: "Approval-related review and discussion."
  }
};

function roleLabel(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant" ? "Assistant" : "System";
  }
  return "You";
}

function roleClassName(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant"
      ? "chat-msg-assistant"
      : "chat-msg-system";
  }
  return "chat-msg-user";
}

function roleIcon(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant" ? "AI" : "SYS";
  }
  return "YOU";
}

function formatAttachmentCount(count: number): string {
  return `${count} image${count === 1 ? "" : "s"}`;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Failed to read ${file.name}.`));
    };
    image.src = objectUrl;
  });
}

async function fileToImageAttachment(
  file: File,
  preserveOriginal: boolean
): Promise<ImageAttachmentPayload> {
  if (preserveOriginal) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error(`Failed to read ${file.name}.`));
      };
      reader.onerror = () => {
        reject(new Error(`Failed to read ${file.name}.`));
      };
      reader.readAsDataURL(file);
    });

    return {
      fileName: file.name,
      mediaType: file.type || "image/jpeg",
      sizeBytes: file.size,
      dataUrl
    };
  }

  const image = await loadImageElement(file);
  const scale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(image.width, image.height)
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(`Failed to process ${file.name}.`);
  }
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);

  const base64 = dataUrl.split(",")[1] ?? "";
  const sizeBytes = Math.ceil((base64.length * 3) / 4);

  return new Promise((resolve) => {
    resolve({
      fileName: file.name,
      mediaType: "image/jpeg",
      sizeBytes,
      dataUrl
    });
  });
}

function threadTypeMeta(type: string | undefined): ThreadTypeMeta {
  if (type && type in THREAD_TYPE_META) {
    return THREAD_TYPE_META[type];
  }
  return {
    label: "Request",
    description: "Request thread."
  };
}

function actionUnavailableReason(
  actionType: string,
  input: Record<string, unknown>
): string {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  const isPostTargetedWrite =
    normalized === "update_post" ||
    normalized === "update_post_fields" ||
    normalized === "update_post_content" ||
    normalized === "edit_post_fields" ||
    normalized === "sitepilot_update_post_fields" ||
    normalized === "set_post_seo_meta" ||
    normalized === "sitepilot_set_post_seo_meta";

  if (isPostTargetedWrite && findNumericPostId(input) === undefined) {
    if (canResolveActionViaPostLookup(actionType, input)) {
      return "target will be resolved via lookup";
    }
    return "missing target post id";
  }

  return "no MCP tool mapping";
}

function actionCanResolveViaLookup(
  actionType: string,
  input: Record<string, unknown>
): boolean {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  return (
    (normalized === "update_post" ||
      normalized === "update_post_fields" ||
      normalized === "update_post_content" ||
      normalized === "edit_post_fields" ||
      normalized === "sitepilot_update_post_fields" ||
      normalized === "set_post_seo_meta" ||
      normalized === "sitepilot_set_post_seo_meta") &&
    actionUnavailableReason(actionType, input) ===
      "target will be resolved via lookup"
  );
}

function actionCreatesDraftPost(actionType: string): boolean {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  return (
    normalized === "create_draft_post" ||
    normalized === "create_draft_content" ||
    normalized === "create_post_draft" ||
    normalized === "sitepilot_create_draft_post"
  );
}

function actionCanResolveViaPlannedCreate(
  actionType: string,
  input: Record<string, unknown>,
  priorActions: Array<{ type: string }>
): boolean {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  const isPostTargetedWrite =
    normalized === "update_post" ||
    normalized === "update_post_fields" ||
    normalized === "update_post_content" ||
    normalized === "edit_post_fields" ||
    normalized === "sitepilot_update_post_fields" ||
    normalized === "set_post_seo_meta" ||
    normalized === "sitepilot_set_post_seo_meta";

  if (!isPostTargetedWrite || findNumericPostId(input) !== undefined) {
    return false;
  }

  return priorActions.filter((action) => actionCreatesDraftPost(action.type)).length === 1;
}

function requestCanExecute(status: string): boolean {
  return (
    status === "approved" ||
    status === "partially_completed" ||
    status === "completed"
  );
}

function requestExecutionControlsLocked(status: string): boolean {
  return status === "completed";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractBeforeAfter(
  value: unknown
): { before: Record<string, unknown> | null; after: unknown } {
  const record = recordValue(value);
  return {
    before: recordValue(record?.before),
    after: record?.after ?? null
  };
}

type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

function stringifyDiffValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function buildDiffLines(beforeValue: unknown, afterValue: unknown): DiffLine[] {
  const beforeLines = stringifyDiffValue(beforeValue).split("\n");
  const afterLines = stringifyDiffValue(afterValue).split("\n");
  const lineCounts = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0)
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lineCounts[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lineCounts[beforeIndex + 1]?.[afterIndex + 1] ?? 0) + 1
          : Math.max(
              lineCounts[beforeIndex + 1]?.[afterIndex] ?? 0,
              lineCounts[beforeIndex]?.[afterIndex + 1] ?? 0
            );
    }
  }

  const diffLines: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      diffLines.push({ kind: "context", text: `  ${beforeLines[beforeIndex]}` });
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    const skipBeforeScore = lineCounts[beforeIndex + 1]?.[afterIndex] ?? 0;
    const skipAfterScore = lineCounts[beforeIndex]?.[afterIndex + 1] ?? 0;

    if (skipBeforeScore >= skipAfterScore) {
      diffLines.push({ kind: "removed", text: `- ${beforeLines[beforeIndex]}` });
      beforeIndex += 1;
      continue;
    }

    diffLines.push({ kind: "added", text: `+ ${afterLines[afterIndex]}` });
    afterIndex += 1;
  }

  while (beforeIndex < beforeLines.length) {
    diffLines.push({ kind: "removed", text: `- ${beforeLines[beforeIndex]}` });
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    diffLines.push({ kind: "added", text: `+ ${afterLines[afterIndex]}` });
    afterIndex += 1;
  }

  return diffLines;
}

function parseJsonDebugValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeImageAttachment(
  attachment: ImageAttachmentPayload
): Record<string, unknown> {
  return {
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes
  };
}

async function copyTextToClipboard(text: string): Promise<void> {
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

export function ChatPage({
  mode = "request"
}: {
  mode?: ChatMode;
}): ReactElement | null {
  const { siteId, data, loading } = useSiteWorkspace();
  const isConversationMode = mode === "conversation";
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<
    string | null
  >(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingThreadTitle, setEditingThreadTitle] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [requestPrompt, setRequestPrompt] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    ImageAttachmentPayload[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plannerJson, setPlannerJson] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [planValidationJson, setPlanValidationJson] = useState<string | null>(
    null
  );
  const [bundle, setBundle] = useState<RequestBundleOk | null>(null);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences | null>(null);
  const [execBusy, setExecBusy] = useState(false);
  const [lastExecHint, setLastExecHint] = useState<string | null>(null);
  const [execProgressLabel, setExecProgressLabel] = useState<string | null>(
    null
  );
  const [dryRunPreview, setDryRunPreview] = useState<DryRunPreview | null>(null);
  const [debugCopyLabel, setDebugCopyLabel] = useState("Copy debug log");
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const debugCopyResetTimerRef = useRef<number | null>(null);

  const loadThreads = useCallback(async () => {
    const res = await window.sitePilotDesktop.listChatThreads({ siteId });
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setErr(null);
    setThreads(
      res.threads.filter((thread) =>
        isConversationMode
          ? thread.type === "conversation"
          : thread.type !== "conversation"
      )
    );
  }, [isConversationMode, siteId]);

  const loadMessages = useCallback(
    async (threadId: string) => {
      const res = await window.sitePilotDesktop.listChatMessages({
        siteId,
        threadId
      });
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setErr(null);
      setMessages(res.messages);
      const latestRequestId =
        [...res.messages]
          .reverse()
          .find((message) => message.requestId !== undefined)?.requestId ?? null;
      setLastRequestId(latestRequestId);
    },
    [siteId]
  );

  useEffect(() => {
    if (!data || data.site.activationStatus !== "active") {
      return;
    }
    void loadThreads();
  }, [data, loadThreads]);

  useEffect(() => {
    let cancelled = false;

    async function loadUiPreferences(): Promise<void> {
      const state = await window.sitePilotDesktop.getSettingsState({});
      if (!cancelled && state.ok) {
        setUiPreferences(state.uiPreferences);
      }
    }

    void loadUiPreferences();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (threads.length === 0) {
      if (selectedThreadId !== null) {
        setSelectedThreadId(null);
      }
      if (editingThreadId !== null) {
        setEditingThreadId(null);
        setEditingThreadTitle("");
      }
      return;
    }
    if (
      selectedThreadId === null ||
      !threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(threads[0]?.id ?? null);
    }
    if (
      editingThreadId !== null &&
      !threads.some((thread) => thread.id === editingThreadId)
    ) {
      setEditingThreadId(null);
      setEditingThreadTitle("");
    }
  }, [editingThreadId, selectedThreadId, threads]);

  useEffect(() => {
    if (editingThreadId === null) {
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editingThreadId]);

  useEffect(() => {
    if (selectedThreadId) {
      void loadMessages(selectedThreadId);
    } else {
      setMessages([]);
    }
  }, [selectedThreadId, loadMessages]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [selectedThreadId]);

  const loadBundle = useCallback(async () => {
    if (isConversationMode) {
      setBundle(null);
      return;
    }
    if (!selectedThreadId || lastRequestId === null) {
      setBundle(null);
      return;
    }
    const res = await window.sitePilotDesktop.getRequestBundle({
      siteId,
      threadId: selectedThreadId,
      requestId: lastRequestId
    });
    if (!res.ok) {
      setErr(res.message);
      setBundle(null);
      return;
    }
    setErr(null);
    setBundle(res);
  }, [isConversationMode, siteId, selectedThreadId, lastRequestId]);

  useEffect(() => {
    void loadBundle();
  }, [loadBundle]);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }
    node.scrollTo({
      top: node.scrollHeight,
      behavior: "smooth"
    });
  }, [
    messages,
    bundle?.request.status,
    bundle?.plan?.id,
    execProgressLabel,
    lastExecHint
  ]);

  const executableActions = useMemo(
    () =>
      bundle?.plan?.proposedActions.filter((action, actionIndex, actions) => {
        const priorActions = actions.slice(0, actionIndex);
        return (
          actionToMcpToolCall(action.type, action.input, true) !== null ||
          actionCanResolveViaLookup(action.type, action.input) ||
          actionCanResolveViaPlannedCreate(
            action.type,
            action.input,
            priorActions
          )
        );
      }) ?? [],
    [bundle?.plan]
  );
  const canRunPlanDirectly = executableActions.length > 0;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);

  const cancelThreadRename = useCallback(() => {
    setEditingThreadId(null);
    setEditingThreadTitle("");
    setRenamingThreadId(null);
  }, []);

  const startThreadRename = useCallback((thread: ThreadRow) => {
    setSelectedThreadId(thread.id);
    setPendingDeleteThreadId(null);
    setEditingThreadId(thread.id);
    setEditingThreadTitle(thread.title);
    setErr(null);
  }, []);

  const submitThreadRename = useCallback(async (): Promise<void> => {
    if (editingThreadId === null) {
      return;
    }

    const title = editingThreadTitle.trim();
    if (title.length === 0) {
      setErr("Request title cannot be empty.");
      return;
    }

    const thread = threads.find((candidate) => candidate.id === editingThreadId);
    if (!thread) {
      cancelThreadRename();
      return;
    }

    if (thread.title === title) {
      cancelThreadRename();
      return;
    }

    setRenamingThreadId(editingThreadId);
    setErr(null);
    const res = await window.sitePilotDesktop.renameChatThread({
      siteId,
      threadId: editingThreadId,
      title
    });
    setRenamingThreadId(null);
    if (!res.ok) {
      setErr(res.message);
      return;
    }

    setThreads((currentThreads) =>
      currentThreads.map((currentThread) =>
        currentThread.id === res.thread.id ? res.thread : currentThread
      )
    );
    setSelectedThreadId(res.thread.id);
    cancelThreadRename();
  }, [
    cancelThreadRename,
    editingThreadId,
    editingThreadTitle,
    siteId,
    threads
  ]);

  const savePendingThreadRename = useCallback(() => {
    if (editingThreadId === null || renamingThreadId !== null) {
      return;
    }

    void submitThreadRename();
  }, [editingThreadId, renamingThreadId, submitThreadRename]);

  async function onCreateThread(): Promise<void> {
    setBusy(true);
    setErr(null);
    const title = `${isConversationMode ? "Conversation" : "Request"} ${new Date().toLocaleString()}`;
    const res = await window.sitePilotDesktop.createChatThread({
      siteId,
      title,
      type: isConversationMode ? "conversation" : "general_request"
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await loadThreads();
    setSelectedThreadId(res.thread.id);
    startThreadRename(res.thread);
  }

  async function onDeleteThread(threadId: string): Promise<void> {
    const nextSelectedThreadId =
      selectedThreadId === threadId
        ? threads.find((thread) => thread.id !== threadId)?.id ?? null
        : selectedThreadId;

    setDeletingThreadId(threadId);
    setErr(null);
    const res = await window.sitePilotDesktop.deleteChatThread({
      siteId,
      threadId
    });
    setDeletingThreadId(null);
    if (!res.ok) {
      setErr(res.message);
      return;
    }

    if (selectedThreadId === threadId) {
      setSelectedThreadId(nextSelectedThreadId);
      setMessages([]);
      setLastRequestId(null);
      setBundle(null);
      setPlannerJson(null);
      setPlanValidationJson(null);
      setLastExecHint(null);
      setExecProgressLabel(null);
      setRequestPrompt("");
    }

    setPendingDeleteThreadId(null);
    if (editingThreadId === threadId) {
      cancelThreadRename();
    }
    await loadThreads();
  }

  async function onSubmitPrompt(): Promise<void> {
    if (!selectedThreadId || requestPrompt.trim().length === 0) {
      return;
    }

    const text = requestPrompt.trim();
    const attachments = pendingAttachments;
    setBusy(true);
    setErr(null);

    if (isConversationMode) {
      const res = await window.sitePilotDesktop.postChatMessage({
        siteId,
        threadId: selectedThreadId,
        text,
        ...(attachments.length > 0 ? { attachments } : {})
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      setPendingAttachments([]);
      await loadMessages(selectedThreadId);
      await loadThreads();
      return;
    }

    if (bundle?.request.status === "clarifying") {
      const res = await window.sitePilotDesktop.answerClarification({
        siteId,
        threadId: selectedThreadId,
        requestId: bundle.request.id,
        answer: text,
        ...(attachments.length > 0 ? { attachments } : {})
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      setPendingAttachments([]);
      await loadMessages(selectedThreadId);
      await loadBundle();
      return;
    }

    if (
      bundle &&
      (bundle.request.status === "new" || bundle.request.status === "drafted")
    ) {
      const res = await window.sitePilotDesktop.amendRequest({
        siteId,
        threadId: selectedThreadId,
        requestId: bundle.request.id,
        text,
        ...(attachments.length > 0 ? { attachments } : {})
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      setPendingAttachments([]);
      setPlanValidationJson(null);
      await loadMessages(selectedThreadId);
      await loadBundle();
      return;
    }

    if (
      bundle &&
      (bundle.request.status === "awaiting_approval" ||
        bundle.request.status === "approved")
    ) {
      const res = await window.sitePilotDesktop.amendRequest({
        siteId,
        threadId: selectedThreadId,
        requestId: bundle.request.id,
        text,
        ...(attachments.length > 0 ? { attachments } : {})
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      setPendingAttachments([]);
      setPlanValidationJson(null);
      setLastExecHint(null);
      await loadMessages(selectedThreadId);
      await loadBundle();
      return;
    }

    if (bundle && bundle.request.status === "executing") {
      const res = await window.sitePilotDesktop.postChatMessage({
        siteId,
        threadId: selectedThreadId,
        text,
        ...(attachments.length > 0 ? { attachments } : {})
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      setPendingAttachments([]);
      await loadMessages(selectedThreadId);
      await loadBundle();
      return;
    }

    const res = await window.sitePilotDesktop.createChatRequest({
      siteId,
      threadId: selectedThreadId,
      userPrompt: text,
      ...(attachments.length > 0 ? { attachments } : {})
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setLastRequestId(res.request.id);
    setPlanValidationJson(null);
    setLastExecHint(null);
    setRequestPrompt("");
    setPendingAttachments([]);
    await loadMessages(selectedThreadId);
    await loadThreads();
  }

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key !== "Enter" ||
        !event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        busy ||
        requestPrompt.trim().length === 0
      ) {
        return;
      }

      event.preventDefault();
      void onSubmitPrompt();
    },
    [busy, onSubmitPrompt, requestPrompt]
  );

  async function onPickAttachments(
    fileList: FileList | null
  ): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const files = [...fileList];
    if (pendingAttachments.length + files.length > MAX_IMAGE_ATTACHMENTS) {
      setErr(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`);
      return;
    }

    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setErr(`${file.name} is not an image.`);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setErr(`${file.name} is larger than 8 MB.`);
        return;
      }
    }

    try {
      const attachments = await Promise.all(
        files.map((file) =>
          fileToImageAttachment(
            file,
            uiPreferences?.preserveOriginalImageUploads ?? false
          )
        )
      );
      setPendingAttachments((current) => [...current, ...attachments]);
      setErr(null);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Failed to read image.");
    }
  }

  async function onGeneratePlan(): Promise<void> {
    if (!selectedThreadId || lastRequestId === null) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.generateActionPlan({
      siteId,
      threadId: selectedThreadId,
      requestId: lastRequestId
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      setPlanValidationJson(null);
      return;
    }
    setPlanValidationJson(JSON.stringify(res.validation, null, 2));
    await loadBundle();
    await loadMessages(selectedThreadId);
  }

  async function onAnalyzeRequestVisualAnalysis(): Promise<void> {
    if (!selectedThreadId || bundle === null) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.analyzeRequestVisualAnalysis({
      siteId,
      threadId: selectedThreadId,
      requestId: bundle.request.id
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setPlanValidationJson(null);
    await loadBundle();
  }

  async function onReviewRequestVisualAnalysis(): Promise<void> {
    if (!selectedThreadId || bundle === null) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.reviewRequestVisualAnalysis({
      siteId,
      threadId: selectedThreadId,
      requestId: bundle.request.id
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await loadBundle();
  }

  async function onBuildPlannerContext(): Promise<void> {
    if (!selectedThreadId) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.buildPlannerContext({
      siteId,
      threadId: selectedThreadId
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      setPlannerJson(null);
      return;
    }
    setPlannerJson(JSON.stringify(res.context, null, 2));
  }

  async function onExecuteAction(
    actionId: string,
    dryRun: boolean
  ): Promise<void> {
    if (!bundle?.plan || lastRequestId === null) {
      return;
    }
    const action = bundle.plan.proposedActions.find(
      (candidate) => candidate.id === actionId
    );
    const requestInput =
      action !== undefined
        ? actionToMcpToolCall(action.type, action.input, true)?.arguments
        : undefined;
    setExecBusy(true);
    setErr(null);
    setLastExecHint(null);
    setExecProgressLabel(`${dryRun ? "Running dry-run" : "Executing"}…`);
    const res = await window.sitePilotDesktop.executePlanAction({
      siteId,
      requestId: lastRequestId,
      planId: bundle.plan.id,
      actionId,
      dryRun
    });
    setExecBusy(false);
    setExecProgressLabel(null);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    if (dryRun && action !== undefined) {
      setDryRunPreview({
        actionId,
        actionType: action.type,
        ...(res.toolName !== undefined ? { toolName: res.toolName } : {}),
        ...(requestInput !== undefined ? { requestInput } : {}),
        mcpResult: res.mcpResult
      });
    } else if (!dryRun) {
      setDryRunPreview(null);
    }
    if (res.skipped) {
      setLastExecHint(
        `Skipped: ${res.mcpResult.reason as string} (${String(res.mcpResult.actionType)})`
      );
    } else if (res.reused) {
      setLastExecHint("Reused completed execution (same idempotency key).");
    } else {
      setLastExecHint(
        `${dryRun ? "Dry-run" : "Executed"}${res.toolName ? ` · ${res.toolName}` : ""} · ok`
      );
    }
    await loadBundle();
    if (selectedThreadId) {
      await loadMessages(selectedThreadId);
    }
  }

  async function onRunPlan(dryRun: boolean): Promise<void> {
    if (!canRunPlanDirectly) {
      setLastExecHint("Run actions individually below for this plan.");
      return;
    }
    if (executableActions.length === 0) {
      setLastExecHint("No executable actions are available.");
      return;
    }
    for (const action of executableActions) {
      await onExecuteAction(action.id, dryRun);
    }
  }

  useEffect(() => {
    setDryRunPreview(null);
  }, [selectedThreadId, lastRequestId]);

  useEffect(() => {
    return () => {
      if (debugCopyResetTimerRef.current !== null) {
        window.clearTimeout(debugCopyResetTimerRef.current);
      }
    };
  }, []);

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  const composerState = useMemo(() => {
    if (isConversationMode) {
      return {
        title: "Conversation",
        helper:
          "Research and read-only site chat. Ask questions, look up posts, inspect site content, or paste an external link and ask to turn it into a new Request.",
        placeholder:
          "Ask about site content, or paste a link and ask to use it in a new Request…",
        actionLabel: "Send"
      };
    }

    if (!bundle) {
      return {
        title: "New request",
        helper:
          "Start with what you want changed on the site. SitePilot will ask follow-up questions if it needs more detail.",
        placeholder: "Ask SitePilot to create, edit, or analyse something…",
        actionLabel: "Send"
      };
    }

    switch (bundle.request.status) {
      case "clarifying":
        return {
          title: "Answer question",
          helper:
            "Reply here to answer the assistant's clarification question and keep the same request moving.",
          placeholder: "Answer the assistant's question…",
          actionLabel: "Reply"
        };
      case "new":
      case "drafted":
        return {
          title: "Refine request",
          helper:
            "Add more context here. The current request will be updated; generate an action plan only when you're ready.",
          placeholder: "Add more detail to the current request…",
          actionLabel: "Update request"
        };
      case "awaiting_approval":
        return {
          title: "Revise request",
          helper:
            "Add changes here to revise the request. SitePilot will update it and you can generate a fresh action plan after that.",
          placeholder: "Describe how the request should change…",
          actionLabel: "Update request"
        };
      case "approved":
        return {
          title: "Revise request",
          helper:
            canRunPlanDirectly
              ? SHOW_DRY_RUN_UI
                ? "Add changes here to revise the approved request. SitePilot will update it, and you can generate a fresh action plan before running anything."
                : "Add changes here to revise the approved request. SitePilot will update it, and you can generate a fresh action plan before running anything."
              : "Add changes here to revise the approved request. SitePilot will update it and you can generate a fresh action plan.",
          placeholder: "Describe how the approved request should change…",
          actionLabel: "Update request"
        };
      case "executing":
        return {
          title: "Add note",
          helper:
            "Execution is running. You can leave notes here while SitePilot processes the request.",
          placeholder: "Add a note for this request…",
          actionLabel: "Add note"
        };
      default:
        return {
          title: "New request",
          helper:
            "The last request is closed. Start a new request here in the same request history or create a new request.",
          placeholder: "Ask SitePilot to do the next thing…",
          actionLabel: "Send"
        };
    }
  }, [bundle, canRunPlanDirectly, isConversationMode]);

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
  const canGeneratePlanNow = canGeneratePlan && visualAnalysisReadyForPlanning;
  const executionControlsLocked =
    bundle !== null && requestExecutionControlsLocked(bundle.request.status);
  const developerToolsEnabled = uiPreferences?.developerToolsEnabled ?? false;
  const preserveOriginalImageUploads =
    uiPreferences?.preserveOriginalImageUploads ?? false;
  const activityLabel =
    execProgressLabel ??
    (deletingThreadId !== null
      ? `Deleting ${isConversationMode ? "conversation" : "request"}`
      : renamingThreadId !== null
        ? `Saving ${isConversationMode ? "conversation" : "request"}`
        : busy
          ? "Working"
          : null);

  const chatEnabled = data.site.activationStatus === "active";
  const developerMessages = [
    ...(err ? [`Error: ${err}`] : []),
    ...(activityLabel ? [`Activity: ${activityLabel}`] : []),
    ...(execProgressLabel ? [`Execution: ${execProgressLabel}`] : []),
    ...(lastExecHint ? [`Hint: ${lastExecHint}`] : []),
    ...(visualAnalysisRequired && !visualAnalysisReadyForPlanning
      ? [
          visualAnalysisStale
            ? "Visual analysis: stale review artifact; re-run analysis before planning."
            : "Visual analysis: required before planning."
        ]
      : [])
  ];
  const pendingAttachmentBytes = pendingAttachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0
  );
  const debugExport = useMemo(
    () => ({
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
    }),
    [
      activityLabel,
      busy,
      bundle,
      data.site.activationStatus,
      data.site.baseUrl,
      data.site.environment,
      data.site.id,
      data.site.name,
      data.site.workspaceId,
      developerMessages,
      developerToolsEnabled,
      dryRunPreview,
      err,
      execBusy,
      execProgressLabel,
      lastExecHint,
      lastRequestId,
      messages,
      pendingAttachments,
      planValidationJson,
      plannerJson,
      preserveOriginalImageUploads,
      requestPrompt,
      selectedThread,
      selectedThreadId,
      siteId,
      threads
    ]
  );

  const onCopyDebugLog = useCallback(async (): Promise<void> => {
    try {
      await copyTextToClipboard(JSON.stringify(debugExport, null, 2));
      setDebugCopyLabel("Copied");
    } catch (error) {
      setDebugCopyLabel(
        error instanceof Error ? "Copy failed" : "Copy unavailable"
      );
    }

    if (debugCopyResetTimerRef.current !== null) {
      window.clearTimeout(debugCopyResetTimerRef.current);
    }
    debugCopyResetTimerRef.current = window.setTimeout(() => {
      setDebugCopyLabel("Copy debug log");
      debugCopyResetTimerRef.current = null;
    }, 2000);
  }, [debugExport]);

  if (!chatEnabled) {
    return (
      <article className="panel-card gate-card">
        <h1>Chat disabled</h1>
        <p className="lede">
          Chat stays off until the discovery check is reviewed and activation
          completes. Review the latest discovered setup and confirm it to enable chat for
          this site.
        </p>
        <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
          Go to discovery check
        </Link>
      </article>
    );
  }

  return (
    <div className="chat-layout">
      {activityLabel ? (
        <div className="chat-activity-indicator" role="status">
          <span className="activity-spinner" aria-hidden="true" />
          <span>{activityLabel}</span>
        </div>
      ) : null}
      <aside className="chat-threads">
        <div className="chat-threads-header">
          <h2>{isConversationMode ? "Conversations" : "Requests"}</h2>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => void onCreateThread()}
          >
            {isConversationMode ? "New conversation" : "New request"}
          </button>
        </div>
        <ul className="chat-thread-list">
          {threads.map((t) => (
            <li key={t.id} className="chat-thread-row">
              {editingThreadId === t.id ? (
                <form
                  className="chat-thread-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitThreadRename();
                  }}
                >
                  <input
                    ref={renameInputRef}
                    className="chat-thread-edit-input"
                    value={editingThreadTitle}
                    disabled={renamingThreadId === t.id}
                    maxLength={200}
                    onChange={(event) => {
                      setEditingThreadTitle(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelThreadRename();
                      }
                    }}
                  />
                  <div className="chat-thread-edit-actions">
                    <button
                      type="submit"
                      className="btn btn-primary btn-small"
                      disabled={renamingThreadId === t.id}
                    >
                      {renamingThreadId === t.id ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={renamingThreadId === t.id}
                      onClick={() => {
                        cancelThreadRename();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="chat-thread-row-main">
                  <button
                    type="button"
                    className={
                      selectedThreadId === t.id
                        ? "chat-thread-pill is-active"
                        : "chat-thread-pill"
                    }
                    onClick={() => {
                      setPendingDeleteThreadId(null);
                      if (editingThreadId !== null) {
                        cancelThreadRename();
                      }
                      setSelectedThreadId(t.id);
                    }}
                  >
                    <span className="chat-thread-pill-label">{t.title}</span>
                  </button>
                  <div className="chat-thread-row-actions">
                    <button
                      type="button"
                      className="chat-thread-rename"
                      aria-label={`Rename ${t.title}`}
                      disabled={
                        busy || deletingThreadId !== null || renamingThreadId !== null
                      }
                      onClick={() => {
                        startThreadRename(t);
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        className="chat-thread-action-icon"
                      >
                        <path
                          d="M4 20h4l10-10a2.12 2.12 0 1 0-4-4L4 16v4Z"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                        <path
                          d="m13.5 6.5 4 4"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="chat-thread-delete"
                      aria-label={`Delete ${t.title}`}
                      disabled={busy || deletingThreadId !== null}
                      onClick={() => {
                        if (editingThreadId !== null) {
                          cancelThreadRename();
                        }
                        setPendingDeleteThreadId((current) =>
                          current === t.id ? null : t.id
                        );
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        className="chat-thread-action-icon"
                      >
                        <path
                          d="M4 7h16"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="1.8"
                        />
                        <path
                          d="M10 11v6"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="1.8"
                        />
                        <path
                          d="M14 11v6"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="1.8"
                        />
                        <path
                          d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                        <path
                          d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
              {pendingDeleteThreadId === t.id ? (
                <div className="chat-thread-confirm">
                  <p className="small-print">
                    Delete this {isConversationMode ? "conversation" : "request"} and its history?
                  </p>
                  <div className="chat-thread-confirm-actions">
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deletingThreadId !== null}
                      onClick={() => void onDeleteThread(t.id)}
                    >
                      {deletingThreadId === t.id ? "Deleting…" : "Confirm"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={deletingThreadId !== null}
                      onClick={() => {
                        setPendingDeleteThreadId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
      <section className="chat-main">
        {err ? <p className="workspace-error">{err}</p> : null}
        {!selectedThreadId ? (
          <p className="muted">
            Create a {isConversationMode ? "conversation" : "request"} to start messaging.
          </p>
        ) : (
          <>
            <header className="chat-main-header">
              <div>
                <h2>
                  {selectedThread?.title ??
                    (isConversationMode ? "Conversation" : "Request")}
                </h2>
                <p className="muted small-print">
                  {threadTypeMeta(selectedThread?.type).label}
                </p>
                <p className="muted small-print">
                  {threadTypeMeta(selectedThread?.type).description}
                </p>
              </div>
            </header>
            <div className="chat-content-grid">
              <div className="chat-primary-column">
                <div ref={messagesRef} className="chat-messages">
                  {messages.map((m) => (
                    <article key={m.id} className={`chat-msg ${roleClassName(m)}`}>
                      <header className="chat-msg-meta">
                        <span className="chat-msg-author">
                          <span className="chat-msg-icon">{roleIcon(m)}</span>
                          <span>{roleLabel(m)}</span>
                        </span>
                        <time dateTime={m.createdAt}>{m.createdAt}</time>
                      </header>
                      <p className="chat-msg-body">{m.body.value}</p>
                      {m.attachments && m.attachments.length > 0 ? (
                        <div className="chat-image-grid">
                          {m.attachments.map((attachment) => (
                            <figure
                              key={`${m.id}-${attachment.fileName}`}
                              className="chat-image-card"
                            >
                              <img
                                src={attachment.dataUrl}
                                alt={attachment.fileName}
                                className="chat-image-preview"
                              />
                              <figcaption className="small-print">
                                {attachment.fileName}
                              </figcaption>
                            </figure>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>

                <div className="chat-composer-card">
                  <h3>{composerState.title}</h3>
                  <p className="muted small-print">{composerState.helper}</p>
                  <textarea
                    rows={3}
                    value={requestPrompt}
                    placeholder={composerState.placeholder}
                    onFocus={savePendingThreadRename}
                    onKeyDown={handleComposerKeyDown}
                    onChange={(e) => {
                      setRequestPrompt(e.target.value);
                    }}
                  />
                  {pendingAttachments.length > 0 ? (
                    <div className="chat-composer-attachments">
                      <p className="muted small-print">
                        {formatAttachmentCount(pendingAttachments.length)} queued
                      </p>
                      <p className="muted small-print">
                        {preserveOriginalImageUploads
                          ? isConversationMode
                            ? "Original image files will be sent at full size."
                            : "Original image files will be kept at full size for planning and upload."
                          : "Images are resized before planning so they are sent as compressed references instead of full-size originals."}
                        {!isConversationMode
                          ? " The planner uses up to 3 images per request."
                          : ""}
                      </p>
                      <div className="chat-image-grid">
                        {pendingAttachments.map((attachment, index) => (
                          <figure
                            key={`pending-${attachment.fileName}-${index}`}
                            className="chat-image-card"
                          >
                            <img
                              src={attachment.dataUrl}
                              alt={attachment.fileName}
                              className="chat-image-preview"
                            />
                            <figcaption className="small-print">
                              {attachment.fileName}
                            </figcaption>
                            <button
                              type="button"
                              className="chat-image-remove"
                              onClick={() => {
                                setPendingAttachments((current) =>
                                  current.filter(
                                    (_, currentIndex) => currentIndex !== index
                                  )
                                );
                              }}
                            >
                              Remove
                            </button>
                          </figure>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="action-row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={
                        busy || pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS
                      }
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      Add images
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || requestPrompt.trim().length === 0}
                      onClick={() => void onSubmitPrompt()}
                    >
                      {composerState.actionLabel}
                    </button>
                    {bundle?.pendingApproval ? (
                      <Link
                        className="btn btn-secondary"
                        to={`/site/${siteId}/approvals`}
                      >
                        Open approvals
                      </Link>
                    ) : null}
                  </div>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(event) => {
                      void onPickAttachments(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </div>
              </div>

              {!isConversationMode ? <aside className="chat-side-column">
                {bundle ? (
                  <div className="chat-request-panel">
                    <h3>Current request</h3>
                    <p className="chat-request-current">{bundle.request.userPrompt}</p>
                    {bundle.request.attachments &&
                    bundle.request.attachments.length > 0 ? (
                      <div className="chat-request-attachments">
                        <p className="muted small-print">
                          Attached{" "}
                          {formatAttachmentCount(bundle.request.attachments.length)}
                        </p>
                        <div className="chat-image-grid">
                          {bundle.request.attachments.map((attachment) => (
                            <figure
                              key={`request-${attachment.fileName}-${attachment.sizeBytes}`}
                              className="chat-image-card"
                            >
                              <img
                                src={attachment.dataUrl}
                                alt={attachment.fileName}
                                className="chat-image-preview"
                              />
                              <figcaption className="small-print">
                                {attachment.fileName}
                              </figcaption>
                            </figure>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="chat-request-meta">
                      <h4>Request status</h4>
                      <p className="small-print">
                        <span className="badge">{bundle.request.status}</span>
                        {bundle.pendingApproval ? (
                          <>
                            {" "}
                            <span className="badge badge-warn">
                              Pending approval
                            </span>{" "}
                            <Link
                              className="small-print"
                              to={`/site/${siteId}/approvals`}
                            >
                              Open approvals
                            </Link>
                          </>
                        ) : null}
                      </p>
                    </div>
                    {visualAnalysisRequired ? (
                      <div className="chat-bundle-panel">
                        <h4>Reference analysis</h4>
                        <p className="muted small-print">
                          {bundle.visualAnalysis === null
                            ? "This request looks like a screenshot/mockup build. Analyze the uploaded reference before planning."
                            : visualAnalysisStale
                              ? "The request changed after the last screenshot analysis. Re-run analysis, review it, then generate the plan."
                              : bundle.visualAnalysis.reviewedAt === undefined
                                ? "Review the generated screenshot manifest, then approve it for planning."
                                : "Reviewed screenshot manifest is ready for planning."}
                        </p>
                        <p className="small-print">
                          <span className="badge">
                            {bundle.visualAnalysis === null
                              ? "missing"
                              : visualAnalysisStale
                                ? "stale"
                                : bundle.visualAnalysis.reviewedAt === undefined
                                  ? "generated"
                                  : "reviewed"}
                          </span>
                        </p>
                        {bundle.visualAnalysis ? (
                          <>
                            <p className="small-print">
                              <strong>{bundle.visualAnalysis.pageType}</strong>{" "}
                              · {bundle.visualAnalysis.layoutPattern}
                            </p>
                            <p className="small-print">
                              {bundle.visualAnalysis.summary}
                            </p>
                            <div className="chat-planner-panel">
                              <h5>Regions</h5>
                              <ul className="chat-action-list">
                                {bundle.visualAnalysis.regions.map((region) => (
                                  <li
                                    key={region.id}
                                    className="chat-action-row"
                                  >
                                    <div>
                                      <strong>{region.label}</strong>
                                      <div className="muted small-print">
                                        {region.kind} · {region.layout} ·{" "}
                                        {region.position} · confidence{" "}
                                        {Math.round(region.confidence * 100)}%
                                      </div>
                                      <div className="small-print">
                                        {region.contentSummary}
                                      </div>
                                      <div className="muted small-print">
                                        Blocks: {region.suggestedBlocks.join(", ")}
                                      </div>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </div>
                            {bundle.visualAnalysis.mappingWarnings.length > 0 ? (
                              <div className="chat-planner-panel">
                                <h5>Mapping warnings</h5>
                                <ul className="small-print">
                                  {bundle.visualAnalysis.mappingWarnings.map(
                                    (warning) => (
                                      <li key={warning}>{warning}</li>
                                    )
                                  )}
                                </ul>
                              </div>
                            ) : null}
                          </>
                        ) : null}
                        <div className="action-row">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() =>
                              void onAnalyzeRequestVisualAnalysis()
                            }
                          >
                            {bundle.visualAnalysis === null || visualAnalysisStale
                              ? "Analyze reference"
                              : "Re-analyze reference"}
                          </button>
                          {bundle.visualAnalysis !== null && !visualAnalysisStale ? (
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy}
                              onClick={() =>
                                void onReviewRequestVisualAnalysis()
                              }
                            >
                              {bundle.visualAnalysis.reviewedAt === undefined
                                ? "Approve analysis"
                                : "Re-approve analysis"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    <div className="action-row">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy || !canGeneratePlanNow}
                        onClick={() => void onGeneratePlan()}
                      >
                        Generate action plan
                      </button>
                    </div>
                    {canGeneratePlan && !canGeneratePlanNow ? (
                      <p className="muted small-print">
                        Generate action plan stays locked until the reference
                        analysis is current and approved.
                      </p>
                    ) : null}
                    {bundle.plan && executableActions.length > 0 ? (
                      <div className="chat-plan-runbar">
                        <div>
                          <h4>Run plan</h4>
                          <p className="muted small-print">
                            {canRunPlanDirectly
                              ? executionControlsLocked
                                ? "This plan has already been executed. Generate a new action plan to run it again."
                                : requestCanExecute(bundle.request.status)
                                ? executableActions.length > 1
                                  ? "The approved plan is ready to run end-to-end."
                                  : "The approved plan is ready to run."
                                : SHOW_DRY_RUN_UI
                                  ? executableActions.length > 1
                                    ? "You can dry-run every executable action in this plan now. Execution unlocks once the request is ready to run."
                                    : "You can dry-run this plan now. Execution unlocks once the request is ready to run."
                                  : "Execution unlocks once the request is ready to run."
                              : "Run actions individually below for this plan."}
                          </p>
                        </div>
                        {canRunPlanDirectly ? (
                          <div className="chat-plan-runbar-actions">
                            {SHOW_DRY_RUN_UI && !executionControlsLocked ? (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={execBusy || busy}
                                onClick={() => void onRunPlan(true)}
                              >
                                {execBusy &&
                                execProgressLabel === "Running dry-run…"
                                  ? "Running dry-run…"
                                  : executableActions.length > 1
                                    ? "Dry-run all"
                                    : "Dry-run plan"}
                              </button>
                            ) : null}
                            {!executionControlsLocked ? (
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={
                                  execBusy ||
                                  busy ||
                                  !requestCanExecute(bundle.request.status)
                                }
                                onClick={() => void onRunPlan(false)}
                              >
                                {execBusy && execProgressLabel === "Executing…"
                                  ? "Executing…"
                                  : executableActions.length > 1
                                    ? "Execute all"
                                    : "Execute plan"}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {bundle.lastExecution ? (
                      <p className="muted small-print">
                        Last run: <code>{bundle.lastExecution.status}</code> ·{" "}
                        <code className="break-all">
                          {bundle.lastExecution.idempotencyKey}
                        </code>
                      </p>
                    ) : null}
                    {dryRunPreview ? (
                      <div className="chat-bundle-panel">
                        {(() => {
                          const { before, after } = extractBeforeAfter(
                            dryRunPreview.mcpResult
                          );
                          const diffLines = buildDiffLines(before, after);

                          return (
                            <>
                        <div className="chat-plan-runbar">
                          <div>
                            <h4>Dry-run Preview</h4>
                            <p className="muted small-print">
                              {dryRunPreview.actionType}
                              {dryRunPreview.toolName
                                ? ` → ${dryRunPreview.toolName}`
                                : ""}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            onClick={() => setDryRunPreview(null)}
                          >
                            Clear
                          </button>
                        </div>
                        {dryRunPreview.requestInput ? (
                          <>
                            <h5>Planned MCP request</h5>
                            <pre className="diag-json">
                              {JSON.stringify(dryRunPreview.requestInput, null, 2)}
                            </pre>
                          </>
                        ) : null}
                        <h5>Diff</h5>
                        <pre className="chat-diff-view" aria-label="Dry-run diff">
                          {diffLines.map((line, index) => (
                            <span
                              key={`${line.kind}-${index}-${line.text}`}
                              className={`chat-diff-line chat-diff-line-${line.kind}`}
                            >
                              {line.text}
                            </span>
                          ))}
                        </pre>
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                    {bundle.plan ? (
                      <div className="chat-bundle-panel">
                        <h4>Planned actions</h4>
                        <ul className="chat-action-list">
                          {bundle.plan.proposedActions.map((action) => {
                            const planActions = bundle.plan?.proposedActions ?? [];
                            const actionIndex =
                              planActions.findIndex(
                                (candidate) => candidate.id === action.id
                              );
                            const priorActions =
                              actionIndex > 0
                                ? planActions.slice(0, actionIndex)
                                : [];
                            const spec = actionToMcpToolCall(
                              action.type,
                              action.input,
                              true
                            );
                            const remote =
                              spec !== null ||
                              actionCanResolveViaLookup(
                                action.type,
                                action.input
                              ) ||
                              actionCanResolveViaPlannedCreate(
                                action.type,
                                action.input,
                                priorActions
                              );
                            return (
                              <li key={action.id} className="chat-action-row">
                                <div>
                                  <strong>{action.type}</strong>
                                  {remote ? (
                                    <span className="muted small-print">
                                      {" "}
                                      →{" "}
                                      {spec?.toolName ??
                                        (actionCanResolveViaLookup(
                                          action.type,
                                          action.input
                                        )
                                          ? "target via lookup"
                                          : "target via planned create")}
                                    </span>
                                  ) : (
                                    <span className="muted small-print">
                                      {" "}
                                      ({actionUnavailableReason(
                                        action.type,
                                        action.input
                                      )})
                                    </span>
                                  )}
                                </div>
                                <div className="chat-action-buttons">
                                  {remote ? (
                                    <>
                                      {SHOW_DRY_RUN_UI &&
                                      !executionControlsLocked ? (
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-small"
                                          disabled={execBusy || busy}
                                          onClick={() =>
                                            void onExecuteAction(action.id, true)
                                          }
                                        >
                                          Dry-run
                                        </button>
                                      ) : null}
                                      {!executionControlsLocked ? (
                                        <button
                                          type="button"
                                          className="btn btn-primary btn-small"
                                          disabled={
                                            execBusy ||
                                            busy ||
                                            !requestCanExecute(bundle.request.status)
                                          }
                                          onClick={() =>
                                            void onExecuteAction(action.id, false)
                                          }
                                        >
                                          Execute
                                        </button>
                                      ) : null}
                                    </>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        {executionControlsLocked ? (
                          <p className="muted small-print">
                            This plan has already run. Generate a new action plan
                            to enable execution again.
                          </p>
                        ) : !requestCanExecute(bundle.request.status) ? (
                          <p className="muted small-print">
                            Execute stays disabled until the request is ready to run.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="muted small-print">
                        No plan yet. Keep refining the request, then generate a
                        plan.
                      </p>
                    )}
                  </div>
                ) : null}

                {developerToolsEnabled ? (
                  <details className="chat-debug-panel">
                    <summary>Developer tools</summary>
                    <div className="chat-debug-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={busy || execBusy}
                        onClick={() => void onCopyDebugLog()}
                      >
                        {debugCopyLabel}
                      </button>
                      <span className="muted small-print">
                        Copies chat history, request state, plan data, and last
                        execution details as JSON.
                      </span>
                    </div>
                    {developerMessages.length > 0 ? (
                      <div className="chat-planner-panel">
                        <h3>Feedback log</h3>
                        <ul className="small-print">
                          {developerMessages.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                {bundle ? (
                  <div className="chat-planner-panel">
                    <h3>Current request prompt</h3>
                    <pre className="diag-json">{bundle.request.userPrompt}</pre>
                  </div>
                ) : null}
                    {pendingAttachments.length > 0 ? (
                      <div className="chat-planner-panel">
                        <h3>Pending image context</h3>
                        <p className="small-print">
                          {formatAttachmentCount(pendingAttachments.length)} ·{" "}
                          {Math.round(pendingAttachmentBytes / 1024)} KB after
                          compression · planner limit 3 images
                        </p>
                      </div>
                    ) : null}
                    {planValidationJson ? (
                      <div className="chat-planner-panel">
                        <h3>Plan validation</h3>
                        <pre className="diag-json">{planValidationJson}</pre>
                      </div>
                    ) : null}
                    {bundle?.plan ? (
                      <div className="chat-planner-panel">
                        <h3>Planned action input</h3>
                        <pre className="diag-json">
                          {JSON.stringify(bundle.plan.proposedActions, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {bundle?.lastExecution?.toolInvocation ? (
                      <div className="chat-planner-panel">
                        <h3>Last MCP request</h3>
                        <p className="muted small-print">
                          Tool: {bundle.lastExecution.toolInvocation.toolName}
                        </p>
                        <pre className="diag-json">
                          {JSON.stringify(
                            bundle.lastExecution.toolInvocation.input,
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    ) : null}
                    {bundle?.lastExecution?.toolInvocation?.output ? (
                      <div className="chat-planner-panel">
                        <h3>Last MCP response</h3>
                        <pre className="diag-json">
                          {JSON.stringify(
                            bundle.lastExecution.toolInvocation.output,
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    ) : null}
                    <div className="chat-planner-panel">
                      <h3>Planner context</h3>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={busy}
                        onClick={() => void onBuildPlannerContext()}
                      >
                        Build planner context
                      </button>
                      {plannerJson ? (
                        <pre className="diag-json">{plannerJson}</pre>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </aside> : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
