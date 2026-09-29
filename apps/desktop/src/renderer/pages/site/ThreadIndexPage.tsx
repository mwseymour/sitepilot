import { useMemo, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { SiteActivityThread } from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";
import {
  chatPathFor,
  formatWhen,
  targetLabel,
  threadStatus,
  threadsNeedingYou,
  type StatusTone
} from "../../status.js";

type Filter = "all" | "needs-you" | "in-progress" | "done";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "in-progress", label: "In progress" },
  { id: "done", label: "Done" }
];

const IN_PROGRESS: StatusTone[] = ["neutral", "running"];
const DONE: StatusTone[] = ["done", "rolled-back"];

/** Every request (or conversation) for the site, newest activity first. */
export function ThreadIndexPage({
  mode
}: {
  mode: "request" | "conversation";
}): ReactElement | null {
  const { siteId, data, loading, activity } = useSiteWorkspace();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const isConversation = mode === "conversation";

  const threads = useMemo(() => {
    const ofMode = activity.filter((thread) =>
      isConversation ? thread.type === "conversation" : thread.type !== "conversation"
    );
    const needing = new Set(threadsNeedingYou(ofMode).map((t) => t.threadId));
    const q = query.trim().toLowerCase();
    return ofMode.filter((thread) => {
      if (q && !thread.title.toLowerCase().includes(q)) return false;
      if (isConversation || filter === "all") return true;
      if (filter === "needs-you") return needing.has(thread.threadId);
      const tone = threadStatus(thread).tone;
      if (filter === "done") return DONE.includes(tone);
      return IN_PROGRESS.includes(tone) && !needing.has(thread.threadId);
    });
  }, [activity, filter, isConversation, query]);

  if (loading) return <p className="muted">Loading workspace…</p>;
  if (!data) return null;

  const active = data.site.activationStatus === "active";
  const newPath = `/site/${siteId}/${isConversation ? "conversations" : "chat"}?new=1`;
  const noun = isConversation ? "conversation" : "request";

  return (
    <div className="thread-index">
      <header className="thread-index-header">
        <div>
          <h1 className="display-title">
            {isConversation ? "Conversations" : "Requests"}
          </h1>
          <p className="muted">
            {isConversation
              ? "Read-only chats about the site’s content. They never change the site."
              : "Each request builds a change in the site’s editor for you to review, approve and apply."}
          </p>
        </div>
        {active ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate(newPath)}
          >
            {`New ${noun}`}
          </button>
        ) : null}
      </header>

      <div className="thread-index-tools">
        <label className="visually-hidden" htmlFor="thread-index-search">
          {`Search ${noun}s`}
        </label>
        <input
          id="thread-index-search"
          className="thread-index-search"
          type="search"
          placeholder={`Search ${noun}s by title…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {!isConversation ? (
          <div className="segmented" role="group" aria-label="Filter requests">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {threads.length === 0 ? (
        <p className="card home-empty">
          {query || filter !== "all"
            ? `No ${noun}s match that.`
            : `No ${noun}s yet.`}{" "}
          {active && !query && filter === "all" ? (
            <Link to={newPath}>{`Start a ${noun}`}</Link>
          ) : null}
        </p>
      ) : (
        <ul className="card thread-index-list">
          {threads.map((thread) => (
            <ThreadIndexRow key={thread.threadId} siteId={siteId} thread={thread} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadIndexRow({
  siteId,
  thread
}: {
  siteId: string;
  thread: SiteActivityThread;
}): ReactElement {
  const status = threadStatus(thread);
  const target = targetLabel(thread);
  const isConversation = thread.type === "conversation";
  return (
    <li>
      <Link className="thread-index-row" to={chatPathFor(siteId, thread)}>
        {isConversation ? null : (
          <span className={`status-pill tone-${status.tone}`}>{status.label}</span>
        )}
        <span className="thread-index-copy">
          <span className="thread-index-title">{thread.title}</span>
          {target ? <span className="thread-index-meta">{target}</span> : null}
        </span>
        <span className="thread-index-when">{formatWhen(thread.updatedAt)}</span>
      </Link>
    </li>
  );
}
