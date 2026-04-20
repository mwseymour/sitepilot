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
  SitePilotDesktopApi
} from "@sitepilot/contracts";
import { actionToMcpToolCall } from "@sitepilot/services/mcp-action-map";
import {
  canResolveActionViaPostLookup,
  findNumericPostId
} from "@sitepilot/services/post-target-resolution";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

type ThreadRow = ChatThreadPayload;
type MessageRow = ChatMessagePayload;

type RequestBundleOk = Extract<
  Awaited<ReturnType<SitePilotDesktopApi["getRequestBundle"]>>,
  { ok: true }
>;

/** When false, dry-run entry points are hidden; execution still supports `dryRun` in code paths. */
const SHOW_DRY_RUN_UI = false;

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

export function ChatPage(): ReactElement | null {
  const { siteId, data, loading } = useSiteWorkspace();
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [requestPrompt, setRequestPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plannerJson, setPlannerJson] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [planValidationJson, setPlanValidationJson] = useState<string | null>(
    null
  );
  const [bundle, setBundle] = useState<RequestBundleOk | null>(null);
  const [execBusy, setExecBusy] = useState(false);
  const [lastExecHint, setLastExecHint] = useState<string | null>(null);
  const [execProgressLabel, setExecProgressLabel] = useState<string | null>(
    null
  );
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = useCallback(async () => {
    const res = await window.sitePilotDesktop.listChatThreads({ siteId });
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setErr(null);
    setThreads(res.threads);
  }, [siteId]);

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
    if (threads.length > 0 && selectedThreadId === null) {
      setSelectedThreadId(threads[0]?.id ?? null);
    }
  }, [threads, selectedThreadId]);

  useEffect(() => {
    if (selectedThreadId) {
      void loadMessages(selectedThreadId);
    } else {
      setMessages([]);
    }
  }, [selectedThreadId, loadMessages]);

  const loadBundle = useCallback(async () => {
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
  }, [siteId, selectedThreadId, lastRequestId]);

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
      bundle?.plan?.proposedActions.filter(
        (action) =>
          actionToMcpToolCall(action.type, action.input, true) !== null ||
          actionCanResolveViaLookup(action.type, action.input)
      ) ?? [],
    [bundle?.plan]
  );
  const canRunPlanDirectly = executableActions.length === 1;

  async function onCreateThread(): Promise<void> {
    setBusy(true);
    setErr(null);
    const title = `Thread ${new Date().toLocaleString()}`;
    const res = await window.sitePilotDesktop.createChatThread({
      siteId,
      title
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await loadThreads();
    setSelectedThreadId(res.thread.id);
  }

  async function onSubmitPrompt(): Promise<void> {
    if (!selectedThreadId || requestPrompt.trim().length === 0) {
      return;
    }

    const text = requestPrompt.trim();
    setBusy(true);
    setErr(null);

    if (bundle?.request.status === "clarifying") {
      const res = await window.sitePilotDesktop.answerClarification({
        siteId,
        threadId: selectedThreadId,
        requestId: bundle.request.id,
        answer: text
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
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
        text
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      setPlanValidationJson(null);
      await loadMessages(selectedThreadId);
      await loadBundle();
      return;
    }

    if (
      bundle &&
      (bundle.request.status === "awaiting_approval" ||
        bundle.request.status === "approved" ||
        bundle.request.status === "executing")
    ) {
      if (
        bundle.request.status === "approved" &&
        /^(execute|run|go|dry[\s-]?run)$/i.test(text)
      ) {
        setBusy(false);
        setLastExecHint(
          canRunPlanDirectly
            ? SHOW_DRY_RUN_UI
              ? "Use the Dry-run plan or Execute plan button above."
              : "Use the Execute plan button above."
            : "Use the action buttons in the planned actions list below."
        );
        return;
      }
      const res = await window.sitePilotDesktop.postChatMessage({
        siteId,
        threadId: selectedThreadId,
        text
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setRequestPrompt("");
      await loadMessages(selectedThreadId);
      await loadBundle();
      return;
    }

    const res = await window.sitePilotDesktop.createChatRequest({
      siteId,
      threadId: selectedThreadId,
      userPrompt: text
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
    await loadMessages(selectedThreadId);
    await loadThreads();
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
    const firstExecutableAction = executableActions[0];
    if (!firstExecutableAction) {
      setLastExecHint("No executable actions are available.");
      return;
    }
    await onExecuteAction(firstExecutableAction.id, dryRun);
  }

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  const composerState = useMemo(() => {
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
          title: "Request waiting for approval",
          helper:
            "This request is waiting on approval. Execution stays blocked until approval, but you can still leave a note here if needed.",
          placeholder: "Add a note for this thread…",
          actionLabel: "Add note"
        };
      case "approved":
        return {
          title: "Add note",
          helper:
            canRunPlanDirectly
              ? SHOW_DRY_RUN_UI
                ? "Use the Dry-run plan or Execute plan buttons above. This box is only for optional notes."
                : "Use the Execute plan button above. This box is only for optional notes."
              : "Use the action buttons in the plan below. This box is only for optional notes.",
          placeholder: "Add a note for this thread…",
          actionLabel: "Add note"
        };
      case "executing":
        return {
          title: "Add note",
          helper:
            "Execution is running. You can leave notes here while SitePilot processes the request.",
          placeholder: "Add a note for this thread…",
          actionLabel: "Add note"
        };
      default:
        return {
          title: "New request",
          helper:
            "The last request is closed. Start a new request here in the same thread or create a new thread.",
          placeholder: "Ask SitePilot to do the next thing…",
          actionLabel: "Send"
        };
    }
  }, [bundle, canRunPlanDirectly]);

  const canGeneratePlan =
    selectedThreadId !== null &&
    bundle !== null &&
    (bundle.request.status === "new" || bundle.request.status === "drafted");

  const chatEnabled = data.site.activationStatus === "active";

  if (!chatEnabled) {
    return (
      <article className="panel-card gate-card">
        <h1>Chat disabled</h1>
        <p className="lede">
          Chat stays off until site configuration is reviewed and activation
          completes. Finish your site config and confirm it to enable chat for
          this site.
        </p>
        <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
          Go to site configuration
        </Link>
      </article>
    );
  }

  return (
    <div className="chat-layout">
      <aside className="chat-threads">
        <div className="chat-threads-header">
          <h2>Threads</h2>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => void onCreateThread()}
          >
            New thread
          </button>
        </div>
        <ul className="chat-thread-list">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={
                  selectedThreadId === t.id
                    ? "chat-thread-pill is-active"
                    : "chat-thread-pill"
                }
                onClick={() => {
                  setSelectedThreadId(t.id);
                }}
              >
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="chat-main">
        {err ? <p className="workspace-error">{err}</p> : null}
        {!selectedThreadId ? (
          <p className="muted">Create a thread to start messaging.</p>
        ) : (
          <>
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
                </article>
              ))}
            </div>
            {bundle ? (
              <div className="chat-request-panel">
                <h3>Current request</h3>
                <p className="chat-request-current">{bundle.request.userPrompt}</p>
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
                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !canGeneratePlan}
                    onClick={() => void onGeneratePlan()}
                  >
                    Generate action plan
                  </button>
                </div>
                {bundle.plan && executableActions.length > 0 ? (
                  <div className="chat-plan-runbar">
                    <div>
                      <h4>Run plan</h4>
                      <p className="muted small-print">
                        {canRunPlanDirectly
                          ? bundle.request.status === "approved"
                            ? "The approved plan is ready to run."
                            : SHOW_DRY_RUN_UI
                              ? "You can dry-run this plan now. Execution unlocks after approval."
                              : "Execution unlocks after approval."
                          : "This plan has multiple runnable actions. Use the action buttons below for now."}
                      </p>
                    </div>
                    {canRunPlanDirectly ? (
                      <div className="chat-plan-runbar-actions">
                        {SHOW_DRY_RUN_UI ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={execBusy || busy}
                            onClick={() => void onRunPlan(true)}
                          >
                            {execBusy && execProgressLabel === "Running dry-run…"
                              ? "Running dry-run…"
                              : "Dry-run plan"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={
                            execBusy ||
                            busy ||
                            bundle.request.status !== "approved"
                          }
                          onClick={() => void onRunPlan(false)}
                        >
                          {execBusy && execProgressLabel === "Executing…"
                            ? "Executing…"
                            : "Execute plan"}
                        </button>
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
                {bundle.plan ? (
                  <div className="chat-bundle-panel">
                    <h4>Planned actions</h4>
                    <ul className="chat-action-list">
                      {bundle.plan.proposedActions.map((action) => {
                        const spec = actionToMcpToolCall(
                          action.type,
                          action.input,
                          true
                        );
                        const remote = spec !== null;
                        return (
                          <li key={action.id} className="chat-action-row">
                            <div>
                              <strong>{action.type}</strong>
                              {remote ? (
                                <span className="muted small-print">
                                  {" "}
                                  → {spec.toolName}
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
                                  {SHOW_DRY_RUN_UI ? (
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
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-small"
                                    disabled={
                                      execBusy ||
                                      busy ||
                                      bundle.request.status !== "approved"
                                    }
                                    onClick={() =>
                                      void onExecuteAction(action.id, false)
                                    }
                                  >
                                    Execute
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {bundle.request.status !== "approved" ? (
                      <p className="muted small-print">
                        Execute stays disabled until the request is approved.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="muted small-print">
                    No plan yet. Keep refining the request, then generate a plan.
                  </p>
                )}
              </div>
            ) : null}

            <div className="chat-composer-card">
              <h3>{composerState.title}</h3>
              <p className="muted small-print">{composerState.helper}</p>
              <textarea
                rows={3}
                value={requestPrompt}
                placeholder={composerState.placeholder}
                onChange={(e) => {
                  setRequestPrompt(e.target.value);
                }}
              />
              <div className="action-row">
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
            </div>

            {execProgressLabel ? (
              <p className="small-print workspace-note">{execProgressLabel}</p>
            ) : null}
            {lastExecHint ? (
              <p className="small-print workspace-note">{lastExecHint}</p>
            ) : null}
            {planValidationJson ? (
              <pre className="diag-json">{planValidationJson}</pre>
            ) : null}
            <details className="chat-debug-panel">
              <summary>Developer tools</summary>
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
          </>
        )}
      </section>
    </div>
  );
}
