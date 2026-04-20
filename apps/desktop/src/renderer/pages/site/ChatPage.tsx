import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import type { chatMessageSchema, chatThreadSchema } from "@sitepilot/contracts";
import type { z } from "zod";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

type ThreadRow = z.infer<typeof chatThreadSchema>;
type MessageRow = z.infer<typeof chatMessageSchema>;

function roleLabel(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant" ? "Assistant" : "System";
  }
  return "You";
}

export function ChatPage(): ReactElement | null {
  const { siteId, data, loading } = useSiteWorkspace();
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [composer, setComposer] = useState("");
  const [requestPrompt, setRequestPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plannerJson, setPlannerJson] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [planOutput, setPlanOutput] = useState<string | null>(null);

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

  async function onSendMessage(): Promise<void> {
    if (!selectedThreadId || composer.trim().length === 0) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.postChatMessage({
      siteId,
      threadId: selectedThreadId,
      text: composer.trim()
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setComposer("");
    await loadMessages(selectedThreadId);
    await loadThreads();
  }

  async function onCreateRequest(): Promise<void> {
    if (!selectedThreadId || requestPrompt.trim().length === 0) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.createChatRequest({
      siteId,
      threadId: selectedThreadId,
      userPrompt: requestPrompt.trim()
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setLastRequestId(res.request.id);
    setPlanOutput(null);
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
      setPlanOutput(null);
      return;
    }
    setPlanOutput(
      JSON.stringify({ plan: res.plan, validation: res.validation }, null, 2)
    );
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

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

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
            <div className="chat-messages">
              {messages.map((m) => (
                <article key={m.id} className="chat-msg">
                  <header className="chat-msg-meta">
                    <span>{roleLabel(m)}</span>
                    <time dateTime={m.createdAt}>{m.createdAt}</time>
                  </header>
                  <p className="chat-msg-body">{m.body.value}</p>
                </article>
              ))}
            </div>
            <div className="chat-compose">
              <textarea
                rows={3}
                value={composer}
                placeholder="Message"
                onChange={(e) => {
                  setComposer(e.target.value);
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || composer.trim().length === 0}
                onClick={() => void onSendMessage()}
              >
                Send
              </button>
            </div>
            <div className="chat-request-panel">
              <h3>Typed request</h3>
              <p className="muted small-print">
                Creates a persisted request for this thread. Vague prompts enter
                clarification; similar prompts get duplicate warnings (T20–T22).
              </p>
              <textarea
                rows={3}
                value={requestPrompt}
                placeholder="Describe what you want done on the site…"
                onChange={(e) => {
                  setRequestPrompt(e.target.value);
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || requestPrompt.trim().length === 0}
                onClick={() => void onCreateRequest()}
              >
                Create request
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || lastRequestId === null}
                onClick={() => void onGeneratePlan()}
              >
                Generate action plan
              </button>
              {lastRequestId ? (
                <p className="muted small-print">
                  Last request id: <code>{lastRequestId}</code>
                </p>
              ) : null}
              {planOutput ? (
                <pre className="diag-json">{planOutput}</pre>
              ) : null}
            </div>
            <div className="chat-planner-panel">
              <h3>Planner context (debug)</h3>
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
          </>
        )}
      </section>
    </div>
  );
}
