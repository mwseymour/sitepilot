import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams
} from "react-router-dom";

import type {
  GutenbergV2ExecutionState,
  ImageAttachmentPayload,
  UiPreferences
} from "@sitepilot/contracts";

import { modePageCopy } from "../../chat-workflow.js";
import {
  notifyActivityChanged,
  useSiteWorkspace
} from "../../site-workspace/site-workspace-context.js";
import type { HomeDraft } from "./OverviewPage.js";
import { ApplyProgress } from "./chat/ApplyProgress.js";
import { RequestStepper } from "./chat/RequestStepper.js";
import {
  GutenbergV2CandidatePanel,
  type GutenbergV2UiState,
  type ReviewArtifact
} from "./GutenbergV2CandidatePanel.js";
import { useAppBusy } from "../../button-loading.js";
import {
  MAX_IMAGE_ATTACHMENTS,
  prepareAttachments,
  validateAttachmentFiles
} from "./chat/attachments.js";
import { Composer } from "./chat/Composer.js";
import { buildDebugExport, copyTextToClipboard } from "./chat/debug-export.js";
import { DeveloperPanel } from "./chat/DeveloperPanel.js";
import { isSystemMessage, threadTypeMeta } from "./chat/message-format.js";
import { MessageFilterBar, MessageList } from "./chat/MessageList.js";
import { RequestPanel } from "./chat/RequestPanel.js";
import { composerCopy } from "./chat/request-view.js";
import { ThreadHeader } from "./chat/ThreadHeader.js";
import type {
  ChatMode,
  GutenbergV2Operation,
  MessageFilter,
  MessageRow,
  RequestBundleOk,
  ThreadRow
} from "./chat/types.js";

export function ChatPage({
  mode = "request"
}: {
  mode?: ChatMode;
}): ReactElement | null {
  const { siteId, data, loading, activity } = useSiteWorkspace();
  const isConversationMode = mode === "conversation";
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const listPath = `/site/${siteId}/${isConversationMode ? "conversations-list" : "requests"}`;
  const urlThreadId = searchParams.get("thread");
  const [applyingSince, setApplyingSince] = useState<number | null>(null);
  const [liveExecState, setLiveExecState] =
    useState<GutenbergV2ExecutionState | null>(null);
  const handledNewKeyRef = useRef<string | null>(null);
  // Loads that finish after the operator moved to another thread are dropped.
  const currentThreadRef = useRef<string | null>(null);
  const currentRequestRef = useRef<string | null>(null);
  const autoSubmitThreadRef = useRef<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<
    string | null
  >(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingThreadTitle, setEditingThreadTitle] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("all");
  const [requestPrompt, setRequestPrompt] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    ImageAttachmentPayload[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<RequestBundleOk | null>(null);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences | null>(
    null
  );
  const [gutenbergV2Operation, setGutenbergV2Operation] =
    useState<GutenbergV2Operation>("create_draft");
  const [gutenbergV2PostType, setGutenbergV2PostType] = useState<
    "post" | "page"
  >("post");
  const [gutenbergV2PostId, setGutenbergV2PostId] = useState("");
  const [gutenbergV2State, setGutenbergV2State] =
    useState<GutenbergV2UiState | null>(null);
  useAppBusy(busy);
  const [lastExecHint, setLastExecHint] = useState<string | null>(null);
  const [execProgressLabel, setExecProgressLabel] = useState<string | null>(
    null
  );
  const [debugCopyLabel, setDebugCopyLabel] = useState("Copy debug log");
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(
    () => new Set()
  );
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const debugCopyResetTimerRef = useRef<number | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const loadThreads = useCallback(async () => {
    const res = await window.sitePilotDesktop.listChatThreads({ siteId });
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setErr(null);
    notifyActivityChanged();
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
      if (currentThreadRef.current !== threadId) return;
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setErr(null);
      setMessages(res.messages);
      const latestRequestId =
        [...res.messages]
          .reverse()
          .find((message) => message.requestId !== undefined)?.requestId ??
        null;
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
      if (!data) {
        return;
      }
      const state = await window.sitePilotDesktop.getSettingsState({
        workspaceId: data.site.workspaceId,
        siteId
      });
      if (!cancelled && state.ok) {
        setUiPreferences(state.uiPreferences);
      }
    }

    void loadUiPreferences();
    return () => {
      cancelled = true;
    };
  }, [data, siteId]);

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
      searchParams.get("new") !== "1" &&
      searchParams.get("thread") === null &&
      (selectedThreadId === null ||
        !threads.some((thread) => thread.id === selectedThreadId))
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

  // Once an update exists, the composer shows the operation it was built for.
  // Moving to a thread without one starts from the default again, rather than
  // keeping the last thread's (say, Publish for another post).
  const v2Target = gutenbergV2State?.target;
  const composerFromThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!v2Target) {
      if (composerFromThreadRef.current !== null && composerFromThreadRef.current !== currentThreadRef.current) {
        composerFromThreadRef.current = null;
        setGutenbergV2Operation("create_draft");
        setGutenbergV2PostId("");
      }
      return;
    }
    composerFromThreadRef.current = currentThreadRef.current;
    setGutenbergV2PostType(v2Target.postType);
    if (v2Target.operation === "create_draft") {
      setGutenbergV2Operation("create_draft");
      return;
    }
    setGutenbergV2PostId(String(v2Target.postId));
    setGutenbergV2Operation(
      v2Target.operation === "set_status"
        ? v2Target.status === "publish"
          ? "publish"
          : "unpublish"
        : v2Target.operation
    );
  }, [v2Target]);

  // The sidebar, Home and ⌘K link straight to a thread with ?thread=<id>.
  useEffect(() => {
    if (
      urlThreadId !== null &&
      urlThreadId !== selectedThreadId &&
      threads.some((thread) => thread.id === urlThreadId)
    ) {
      setSelectedThreadId(urlThreadId);
    }
    // Only follow URL changes; selection changes are mirrored below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlThreadId, threads]);

  useEffect(() => {
    if (selectedThreadId === null || searchParams.get("new") === "1") {
      return;
    }
    if (searchParams.get("thread") !== selectedThreadId) {
      setSearchParams({ thread: selectedThreadId }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

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

  currentThreadRef.current = selectedThreadId;
  currentRequestRef.current = lastRequestId;

  // A different thread never shows the previous thread's request or review.
  const previousThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousThreadRef.current === selectedThreadId) return;
    const hadThread = previousThreadRef.current !== null;
    previousThreadRef.current = selectedThreadId;
    if (!hadThread) return;
    setBundle(null);
    setGutenbergV2State(null);
    setLastRequestId(null);
  }, [selectedThreadId]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [selectedThreadId]);

  useEffect(() => {
    setMessageFilter("all");
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
    const threadId = selectedThreadId;
    const res = await window.sitePilotDesktop.getRequestBundle({
      siteId,
      threadId,
      requestId: lastRequestId
    });
    if (currentThreadRef.current !== threadId) return;
    if (!res.ok) {
      setBundle(null);
      // Switching threads briefly pairs the new thread with the previous
      // thread's request; the message load that follows selects the right one.
      if (res.code !== "thread_mismatch") {
        setErr(res.message);
      }
      return;
    }
    // Do not clear `err` here: this reload runs straight after a failed
    // action and would otherwise hide that action's error.
    setBundle(res);
  }, [isConversationMode, siteId, selectedThreadId, lastRequestId]);

  useEffect(() => {
    void loadBundle();
  }, [loadBundle]);

  const loadGutenbergV2State = useCallback(
    async (requestId: string): Promise<void> => {
      const res = await window.sitePilotDesktop.gutenbergV2GetRequestState({
        siteId,
        requestId
      });
      if (currentRequestRef.current !== requestId) return;
      if (!res.ok) {
        setErr(res.message);
        setGutenbergV2State(null);
        return;
      }
      setGutenbergV2State(res.state);
    },
    [siteId]
  );

  useEffect(() => {
    if (isConversationMode || lastRequestId === null) {
      setGutenbergV2State(null);
      return;
    }
    void loadGutenbergV2State(lastRequestId);
  }, [isConversationMode, lastRequestId, loadGutenbergV2State]);

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
    execProgressLabel,
    lastExecHint
  ]);

  const selectedThread = threads.find(
    (thread) => thread.id === selectedThreadId
  );
  const systemMessageCount = useMemo(
    () => messages.filter(isSystemMessage).length,
    [messages]
  );
  const filteredMessages = useMemo(() => {
    switch (messageFilter) {
      case "non_system":
        return messages.filter((message) => !isSystemMessage(message));
      case "system_only":
        return messages.filter(isSystemMessage);
      default:
        return messages;
    }
  }, [messageFilter, messages]);
  const hasVisibleMessages = filteredMessages.length > 0;

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

    const thread = threads.find(
      (candidate) => candidate.id === editingThreadId
    );
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

  async function startFreshThread(options: {
    draft?: HomeDraft;
    postId?: string | null;
    postType?: string | null;
  }): Promise<void> {
    const { draft } = options;
    setBusy(true);
    setErr(null);
    const fallbackTitle = `${isConversationMode ? "Conversation" : "Request"} ${new Date().toLocaleString()}`;
    const draftTitle = draft?.text.replace(/\s+/g, " ").trim().slice(0, 60);
    const res = await window.sitePilotDesktop.createChatThread({
      siteId,
      title: draftTitle && draftTitle.length > 0 ? draftTitle : fallbackTitle,
      type: isConversationMode ? "conversation" : "general_request"
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await loadThreads();
    setLastRequestId(null);
    setBundle(null);
    setGutenbergV2State(null);
    setMessages([]);
    setSelectedThreadId(res.thread.id);
    setSearchParams({ thread: res.thread.id }, { replace: true });

    const postType =
      options.postType === "page" || options.postType === "post"
        ? options.postType
        : (draft?.postType ?? null);
    if (postType) setGutenbergV2PostType(postType);
    if (options.postId) {
      setGutenbergV2Operation("apply_operations");
      setGutenbergV2PostId(options.postId);
    } else if (draft?.operation) {
      setGutenbergV2Operation(
        draft.operation === "set_status" ? "publish" : draft.operation
      );
      if (draft.operation !== "create_draft") setGutenbergV2PostId("");
    }
    if (draft) {
      setRequestPrompt(draft.text);
      // A new draft or a question can go straight away; other operations
      // still need the post they apply to.
      if (isConversationMode || draft.operation === "create_draft") {
        autoSubmitThreadRef.current = res.thread.id;
      }
    } else if (!options.postId) {
      startThreadRename(res.thread);
      return;
    }
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
    });
  }

  useEffect(() => {
    if (
      searchParams.get("new") !== "1" ||
      !data ||
      data.site.activationStatus !== "active" ||
      handledNewKeyRef.current === location.key
    ) {
      return;
    }
    handledNewKeyRef.current = location.key;
    const draft = (location.state as { homeDraft?: HomeDraft } | null)
      ?.homeDraft;
    void startFreshThread({
      ...(draft ? { draft } : {}),
      postId: searchParams.get("postId"),
      postType: searchParams.get("postType")
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, data, location.key]);

  useEffect(() => {
    if (
      autoSubmitThreadRef.current === null ||
      autoSubmitThreadRef.current !== selectedThreadId ||
      requestPrompt.trim().length === 0 ||
      busy
    ) {
      return;
    }
    autoSubmitThreadRef.current = null;
    void onSubmitPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId, requestPrompt, busy]);

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
    setLastRequestId(null);
    setBundle(null);
    setGutenbergV2State(null);
    setMessages([]);
    setSelectedThreadId(res.thread.id);
    startThreadRename(res.thread);
  }

  async function onDeleteThread(threadId: string): Promise<void> {
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
      // Deleting the open thread goes back to the list.
      navigate(listPath, { replace: true });
      setSelectedThreadId(null);
      setMessages([]);
      setLastRequestId(null);
      setBundle(null);
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

  const gutenbergV2Target = useMemo(() => {
    if (gutenbergV2Operation === "create_draft") {
      return {
        operation: "create_draft" as const,
        postType: gutenbergV2PostType
      };
    }
    const postId = Number(gutenbergV2PostId.trim());
    if (!Number.isSafeInteger(postId) || postId <= 0) {
      return null;
    }
    if (
      gutenbergV2Operation === "publish" ||
      gutenbergV2Operation === "unpublish"
    ) {
      return {
        operation: "set_status" as const,
        postType: gutenbergV2PostType,
        postId,
        status:
          gutenbergV2Operation === "publish"
            ? ("publish" as const)
            : ("draft" as const)
      };
    }
    return {
      operation: gutenbergV2Operation,
      postType: gutenbergV2PostType,
      postId
    };
  }, [gutenbergV2Operation, gutenbergV2PostId, gutenbergV2PostType]);

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

    if (gutenbergV2Target === null) {
      setErr("Choose a native editor operation and complete its target first.");
      setBusy(false);
      return;
    }

    const res = await window.sitePilotDesktop.ingestThreadMessage({
      siteId,
      threadId: selectedThreadId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      gutenbergV2Target
    });
    setBusy(false);
    if (res.request) {
      setLastRequestId(res.request.id);
      // The message is saved on the request even when the follow-on
      // generation fails; leaving it in the box would resend it as a
      // duplicate follow-up.
      setRequestPrompt("");
      setPendingAttachments([]);
    }
    if (!res.ok) {
      setErr(res.message);
      await loadMessages(selectedThreadId);
      await loadThreads();
      await loadBundle();
      return;
    }

    setRequestPrompt("");
    setPendingAttachments([]);
    if (res.gutenbergV2State !== undefined) {
      setGutenbergV2State(res.gutenbergV2State);
    }
    if (res.outcome !== "noted") {
      setLastExecHint(null);
    }
    await loadMessages(selectedThreadId);
    await loadThreads();
    await loadBundle();
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

  async function onPickAttachments(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const files = [...fileList];
    const validationError = validateAttachmentFiles(files);
    if (validationError !== null) {
      setErr(validationError);
      return;
    }

    try {
      const { attachments, notes } = await prepareAttachments(
        files,
        uiPreferences?.preserveOriginalImageUploads ?? false
      );
      if (
        pendingAttachments.length + attachments.length >
        MAX_IMAGE_ATTACHMENTS
      ) {
        setErr(
          `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images or PDF pages per message.`
        );
        return;
      }
      setPendingAttachments((current) => [...current, ...attachments]);
      setErr(notes.length > 0 ? notes.join(" ") : null);
    } catch (error) {
      setErr(
        error instanceof Error ? error.message : "Failed to read the file."
      );
    }
  }

  const onLoadGutenbergV2Artifact = useCallback(
    async (artifactId: string): Promise<ReviewArtifact | null> => {
      if (lastRequestId === null) {
        return null;
      }
      const res = await window.sitePilotDesktop.gutenbergV2GetReviewArtifact({
        siteId,
        requestId: lastRequestId,
        artifactId
      });
      if (!res.ok) {
        setErr(res.message);
        return null;
      }
      return res.artifact;
    },
    [lastRequestId, siteId]
  );

  const onDecideGutenbergV2Candidate = useCallback(
    async (
      candidateId: string,
      decision: "approved" | "rejected" | "revision_requested",
      note?: string
    ): Promise<void> => {
      if (lastRequestId === null) {
        return;
      }
      setBusy(true);
      setErr(null);
      const res = await window.sitePilotDesktop.gutenbergV2DecideCandidate({
        siteId,
        requestId: lastRequestId,
        candidateId,
        decision,
        ...(note !== undefined ? { note } : {})
      });
      setBusy(false);
      if (selectedThreadId) {
        await loadMessages(selectedThreadId);
      }
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setGutenbergV2State(res.state);
      notifyActivityChanged();
      setLastExecHint(
        decision === "approved"
          ? "Candidate approved. Review the execution status before continuing."
          : decision === "revision_requested"
            ? "Revision requested for this candidate."
            : "Candidate rejected."
      );
    },
    [lastRequestId, loadMessages, selectedThreadId, siteId]
  );

  const onExecuteGutenbergV2Candidate = useCallback(async (): Promise<void> => {
    if (lastRequestId === null) {
      return;
    }
    setBusy(true);
    setErr(null);
    setApplyingSince(Date.now());
    setLiveExecState("preparing");
    const requestId = lastRequestId;
    const poll = window.setInterval(() => {
      void window.sitePilotDesktop
        .gutenbergV2GetExecutionProgress({ siteId, requestId })
        .then((progress) => {
          if (progress.ok && progress.state) setLiveExecState(progress.state);
        })
        .catch(() => undefined);
    }, 800);
    const res = await window.sitePilotDesktop
      .gutenbergV2ExecuteCandidate({
        siteId,
        requestId
      })
      .finally(() => {
        window.clearInterval(poll);
        setApplyingSince(null);
        setLiveExecState(null);
      });
    setBusy(false);
    notifyActivityChanged();
    // The execution report is posted to the thread on success and failure.
    if (selectedThreadId) {
      await loadMessages(selectedThreadId);
    }
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setGutenbergV2State(res.state);
    setLastExecHint(
      res.state.state === "succeeded"
        ? "Update completed and was verified."
        : "Execution status refreshed."
    );
    await loadBundle();
  }, [lastRequestId, loadBundle, loadMessages, selectedThreadId, siteId]);

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

  // A thread view always names its thread; otherwise show the list.
  if (searchParams.get("thread") === null && searchParams.get("new") !== "1") {
    return <Navigate to={listPath} replace />;
  }

  // Plain values, not hooks: this code runs after the component's early
  // `loading`/`!data` returns, where hooks would change the hook count.
  const composerState = composerCopy({
    isConversationMode,
    bundle
  });
  const pageCopy = modePageCopy(mode);
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
    ...(lastExecHint ? [`Hint: ${lastExecHint}`] : [])
  ];

  const pendingAttachmentBytes = pendingAttachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0
  );
  const composerRows =
    !isConversationMode &&
    (bundle?.request.status === "awaiting_approval" ||
      bundle?.request.status === "approved" ||
      gutenbergV2State?.state === "review_ready")
      ? 3
      : 2;
  const showBuildingCandidate =
    busy &&
    (gutenbergV2State === null || gutenbergV2State.state !== "review_ready");
  const selectedThreadMeta = threadTypeMeta(selectedThread?.type);
  const shownTarget = gutenbergV2State?.target ?? null;
  const headerChips = isConversationMode
    ? ["Read-only conversation"]
    : shownTarget
      ? [
          shownTarget.operation === "create_draft"
            ? `New ${shownTarget.postType} draft`
            : `${shownTarget.postType === "page" ? "Page" : "Post"} #${shownTarget.postId}`,
          shownTarget.operation === "create_draft"
            ? "Create draft"
            : shownTarget.operation === "replace_content"
              ? "Replace all content"
              : shownTarget.operation === "apply_operations"
                ? "Apply selected changes"
                : shownTarget.status === "publish"
                  ? "Publish"
                  : "Unpublish"
        ]
      : [selectedThreadMeta.label];
  const approvalExpiresAt = activity.find(
    (thread) => thread.requestId === lastRequestId
  )?.approvalExpiresAt;

  const onCopyDebugLog = async (): Promise<void> => {
    try {
      await copyTextToClipboard(
        JSON.stringify(
          buildDebugExport({
            siteId,
            data,
            selectedThreadId,
            lastRequestId,
            developerToolsEnabled,
            preserveOriginalImageUploads,
            busy,
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
            bundle
          }),
          null,
          2
        )
      );
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
  };

  if (!chatEnabled) {
    return (
      <article className="panel-card gate-card">
        <h1>Chat disabled</h1>
        <p className="lede">
          Chat stays off until the discovery check is reviewed and activation
          completes. Review the latest discovered setup and confirm it to enable
          chat for this site.
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
      <section className="chat-main">
        {err && !selectedThreadId ? (
          <p className="workspace-error">{err}</p>
        ) : null}
        {!selectedThreadId ? (
          <p className="muted">
            {pageCopy.emptyState}{" "}
            <Link to={`/site/${siteId}/${pageCopy.otherModePathSegment}`}>
              {pageCopy.otherModeLabel}
            </Link>
          </p>
        ) : (
          <>
            <div className="chat-content-grid">
              <div className="chat-primary-column">
                <ThreadHeader
                  backTo={listPath}
                  backLabel={isConversationMode ? "All conversations" : "All requests"}
                  thread={selectedThread ?? null}
                  fallbackTitle={isConversationMode ? "Conversation" : "Request"}
                  itemLabel={isConversationMode ? "conversation" : "request"}
                  chips={headerChips}
                  progress={
                    !isConversationMode ? (
                      <RequestStepper
                        requestStatus={bundle?.request.status ?? null}
                        v2State={
                          showBuildingCandidate
                            ? "compiling"
                            : (gutenbergV2State?.state ?? null)
                        }
                        applying={applyingSince !== null}
                      />
                    ) : null
                  }
                  filter={
                    systemMessageCount > 0 ? (
                      <MessageFilterBar
                        messageFilter={messageFilter}
                        systemMessageCount={systemMessageCount}
                        onChange={setMessageFilter}
                      />
                    ) : null
                  }
                  isEditing={
                    selectedThread !== undefined &&
                    editingThreadId === selectedThread.id
                  }
                  editingTitle={editingThreadTitle}
                  renameInputRef={renameInputRef}
                  renaming={renamingThreadId !== null}
                  pendingDelete={pendingDeleteThreadId === selectedThreadId}
                  deleting={deletingThreadId !== null}
                  busy={busy}
                  onStartRename={() => {
                    if (selectedThread) startThreadRename(selectedThread);
                  }}
                  onEditingTitleChange={setEditingThreadTitle}
                  onSubmitRename={() => void submitThreadRename()}
                  onCancelRename={cancelThreadRename}
                  onRequestDelete={() => {
                    if (editingThreadId !== null) cancelThreadRename();
                    setPendingDeleteThreadId(selectedThreadId);
                  }}
                  onConfirmDelete={() => {
                    if (selectedThreadId) void onDeleteThread(selectedThreadId);
                  }}
                  onCancelDelete={() => {
                    setPendingDeleteThreadId(null);
                  }}
                />
                {err ? <p className="workspace-error chat-error">{err}</p> : null}
                {hasVisibleMessages ? (
                  <MessageList
                    messages={filteredMessages}
                    containerRef={messagesRef}
                  />
                ) : (
                  <div className="chat-messages chat-messages-empty">
                    <p className="muted">
                      {isConversationMode
                        ? "Ask anything about the site’s content. Conversations only read the site."
                        : "Describe what should change. SitePilot asks if it needs more detail, then builds the update for you to review."}
                    </p>
                  </div>
                )}

                <Composer
                  copy={composerState}
                  isConversationMode={isConversationMode}
                  busy={busy}
                  showSubmitSpinner={busy && applyingSince === null}
                  hasGutenbergV2State={gutenbergV2State !== null}
                  gutenbergV2TargetValid={gutenbergV2Target !== null}
                  gutenbergV2Operation={gutenbergV2Operation}
                  onGutenbergV2OperationChange={setGutenbergV2Operation}
                  gutenbergV2PostType={gutenbergV2PostType}
                  onGutenbergV2PostTypeChange={setGutenbergV2PostType}
                  gutenbergV2PostId={gutenbergV2PostId}
                  onGutenbergV2PostIdChange={setGutenbergV2PostId}
                  textareaRef={composerTextareaRef}
                  textareaRows={composerRows}
                  requestPrompt={requestPrompt}
                  onRequestPromptChange={setRequestPrompt}
                  onTextareaFocus={savePendingThreadRename}
                  onTextareaKeyDown={handleComposerKeyDown}
                  pendingAttachments={pendingAttachments}
                  preserveOriginalImageUploads={preserveOriginalImageUploads}
                  onPickAttachments={(fileList) =>
                    void onPickAttachments(fileList)
                  }
                  onToggleAttachmentPurpose={(index) =>
                    setPendingAttachments((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              purpose:
                                item.purpose === "reference"
                                  ? "media"
                                  : "reference"
                            }
                          : item
                      )
                    )
                  }
                  onRemoveAttachment={(index) => {
                    setPendingAttachments((current) =>
                      current.filter(
                        (_, currentIndex) => currentIndex !== index
                      )
                    );
                  }}
                  onSubmit={() => void onSubmitPrompt()}
                />
              </div>

              {!isConversationMode ? (
                <aside className="chat-side-column">
                  {gutenbergV2State ? (
                    <GutenbergV2CandidatePanel
                      candidate={gutenbergV2State}
                      busy={busy}
                      onDecide={onDecideGutenbergV2Candidate}
                      onExecute={onExecuteGutenbergV2Candidate}
                      onLoadArtifact={onLoadGutenbergV2Artifact}
                      {...(approvalExpiresAt ? { approvalExpiresAt } : {})}
                      siteUrl={data.site.baseUrl}
                      top={
                        <>
                  {applyingSince !== null ? (
                    <ApplyProgress
                      state={liveExecState}
                      startedAt={applyingSince}
                    />
                  ) : null}
                  {showBuildingCandidate && applyingSince === null ? (
                    <section className="review-building" aria-live="polite">
                      <span className="spinner" aria-hidden="true" />
                      <div>
                        <h4>Building the update…</h4>
                        <p>
                          Planning the blocks, then building and previewing
                          them in this site’s WordPress editor. Long posts can
                          take a minute or two.
                        </p>
                      </div>
                    </section>
                  ) : null}
                        </>
                      }
                    >
                      <details className="review-disclosure review-details">
                        <summary>Request details and attachments</summary>
                  {bundle ? (
                    <RequestPanel bundle={bundle} />
                  ) : null}

                  {developerToolsEnabled ? (
                    <DeveloperPanel
                      bundle={bundle}
                      busy={busy}
                      debugCopyLabel={debugCopyLabel}
                      developerMessages={developerMessages}
                      pendingAttachmentCount={pendingAttachments.length}
                      pendingAttachmentBytes={pendingAttachmentBytes}
                      onCopyDebugLog={() => void onCopyDebugLog()}
                    />
                  ) : null}
                      </details>
                    </GutenbergV2CandidatePanel>
                  ) : (
                    <div className="chat-side-scroll">
                      {applyingSince === null && !showBuildingCandidate ? (
                        <section className="review-placeholder">
                          <h3>Review</h3>
                          <p>
                            Once SitePilot has built the update, its preview,
                            changes and the Approve button appear here.
                            Nothing is saved to the site before you approve.
                          </p>
                        </section>
                      ) : null}
                  {applyingSince !== null ? (
                    <ApplyProgress
                      state={liveExecState}
                      startedAt={applyingSince}
                    />
                  ) : null}
                  {showBuildingCandidate && applyingSince === null ? (
                    <section className="review-building" aria-live="polite">
                      <span className="spinner" aria-hidden="true" />
                      <div>
                        <h4>Building the update…</h4>
                        <p>
                          Planning the blocks, then building and previewing
                          them in this site’s WordPress editor. Long posts can
                          take a minute or two.
                        </p>
                      </div>
                    </section>
                  ) : null}
                  {bundle ? (
                    <RequestPanel bundle={bundle} />
                  ) : null}

                  {developerToolsEnabled ? (
                    <DeveloperPanel
                      bundle={bundle}
                      busy={busy}
                      debugCopyLabel={debugCopyLabel}
                      developerMessages={developerMessages}
                      pendingAttachmentCount={pendingAttachments.length}
                      pendingAttachmentBytes={pendingAttachmentBytes}
                      onCopyDebugLog={() => void onCopyDebugLog()}
                    />
                  ) : null}
                    </div>
                  )}
                </aside>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
