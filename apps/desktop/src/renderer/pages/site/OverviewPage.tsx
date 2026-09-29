import { useRef, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { SiteActivityThread } from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";
import { activationLabel } from "../../site-labels.js";
import {
  chatPathFor,
  targetLabel,
  threadStatus,
  threadsNeedingYou
} from "../../status.js";

/** Handed to the chat page through router state when Home starts a request. */
export type HomeDraft = {
  text: string;
  operation?: "create_draft" | "apply_operations" | "set_status";
  postType?: "post" | "page";
};

type Mode = "change" | "ask";

const QUICK_STARTS: Array<{
  label: string;
  mode: Mode;
  text: string;
  operation?: HomeDraft["operation"];
  postType?: HomeDraft["postType"];
}> = [
  {
    label: "Draft a new post",
    mode: "change",
    text: "Draft a new post about ",
    operation: "create_draft",
    postType: "post"
  },
  {
    label: "Edit part of a page",
    mode: "change",
    text: "On the page, change ",
    operation: "apply_operations",
    postType: "page"
  },
  {
    label: "Publish or unpublish",
    mode: "change",
    text: "Publish this post",
    operation: "set_status",
    postType: "post"
  },
  {
    label: "Update SEO fields",
    mode: "change",
    text: "Update the SEO title and meta description to ",
    operation: "apply_operations"
  },
  {
    label: "Build from a screenshot or PDF",
    mode: "change",
    text: "Build a new page that matches the attached layout",
    operation: "create_draft",
    postType: "page"
  },
  {
    label: "Ask about existing content",
    mode: "ask",
    text: "Which posts mention "
  }
];

function actionLabel(thread: SiteActivityThread): string {
  if (thread.v2State === "approved") return "Apply now";
  if (thread.v2State === "review_ready") return "Review";
  if (thread.v2State === "stale_approval") return "Rebuild";
  return "Answer";
}

export function OverviewPage(): ReactElement | null {
  const { siteId, data, loading, activity } = useSiteWorkspace();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>("change");
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<Omit<HomeDraft, "text">>({});

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  const { site, discoveryRevision, discoveryReviewRequired } = data;
  const active = site.activationStatus === "active";
  const discoveryStatus =
    discoveryRevision === null
      ? "Discovery not run yet"
      : discoveryReviewRequired
        ? "Discovery changes need review"
        : "Discovery up to date";
  const needsYou = threadsNeedingYou(activity);

  const start = (): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    const draft: HomeDraft = { text: trimmed, ...preset };
    navigate(
      `/site/${siteId}/${mode === "ask" ? "conversations" : "chat"}?new=1`,
      { state: { homeDraft: draft } }
    );
  };

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-heading">
          <h1 className="display-title">{site.name}</h1>
          <p className="home-meta">
            <span className={`env-pill env-${site.environment}`}>
              {site.environment}
            </span>
            <span>{site.baseUrl.replace(/^https?:\/\//, "")}</span>
            <span aria-hidden="true">·</span>
            <span>{discoveryStatus}</span>
          </p>
        </div>
      </header>

      {active ? (
        <section className="home-start card" aria-labelledby="home-start-heading">
          <div className="home-start-top">
            <h2 id="home-start-heading">
              {mode === "change"
                ? "What should change on the site?"
                : "What do you want to know about the site?"}
            </h2>
            <div className="segmented" role="group" aria-label="Request mode">
              <button
                type="button"
                aria-pressed={mode === "change"}
                onClick={() => {
                  setMode("change");
                }}
              >
                Change the site
              </button>
              <button
                type="button"
                aria-pressed={mode === "ask"}
                onClick={() => {
                  setMode("ask");
                  setPreset({});
                }}
              >
                Just ask
              </button>
            </div>
          </div>
          <label htmlFor="home-start-input" className="visually-hidden">
            {mode === "change" ? "Describe the change" : "Ask a question"}
          </label>
          <textarea
            id="home-start-input"
            ref={inputRef}
            className="home-start-input"
            rows={3}
            value={text}
            placeholder={
              mode === "change"
                ? "e.g. Add Sunday hours to the Opening hours page and refresh its meta description"
                : "e.g. Which pages still mention the summer menu?"
            }
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                start();
              }
            }}
          />
          <div className="home-start-actions">
            <span className="small-print">
              {mode === "change"
                ? "Nothing is written to the site until you approve it."
                : "Conversations only read the site. They never change it."}
            </span>
            <button type="button" className="btn btn-primary" onClick={start}>
              {mode === "change" ? "Start request" : "Ask"}
              <kbd className="btn-kbd">⌘↵</kbd>
            </button>
          </div>
          <div className="home-quick" role="group" aria-label="Quick starts">
            {QUICK_STARTS.map((quick) => (
              <button
                key={quick.label}
                type="button"
                className="chip"
                onClick={() => {
                  setMode(quick.mode);
                  setText(quick.text);
                  setPreset({
                    ...(quick.operation ? { operation: quick.operation } : {}),
                    ...(quick.postType ? { postType: quick.postType } : {})
                  });
                  window.requestAnimationFrame(() => {
                    const input = inputRef.current;
                    if (!input) return;
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                  });
                }}
              >
                {quick.label}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="card home-gate">
          <h2>Finish setting up this site</h2>
          <p className="muted">
            SitePilot needs a confirmed discovery check before it can make
            changes. It’s currently{" "}
            {activationLabel(site.activationStatus).toLowerCase()}.
          </p>
          <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
            Go to discovery check
          </Link>
        </section>
      )}

      <div className="home-columns">
        <section className="home-needs" aria-labelledby="home-needs-heading">
          <h2 id="home-needs-heading" className="section-title">
            Needs you{" "}
            {needsYou.length > 0 ? (
              <span className="section-count">{needsYou.length}</span>
            ) : null}
          </h2>
          {needsYou.length === 0 ? (
            <p className="card home-empty">
              Nothing is waiting on you. New requests show up here when they
              need an answer, a review or an approval.
            </p>
          ) : (
            <ul className="card home-needs-list">
              {needsYou.map((thread) => {
                const status = threadStatus(thread);
                const target = targetLabel(thread);
                const primary = thread.v2State === "review_ready";
                return (
                  <li key={thread.threadId} className="home-needs-row">
                    <span className={`status-pill tone-${status.tone}`}>
                      {status.label}
                    </span>
                    <span className="home-needs-copy">
                      <span className="home-needs-title">{thread.title}</span>
                      {target ? (
                        <span className="home-needs-meta">{target}</span>
                      ) : null}
                    </span>
                    <Link
                      className={`btn btn-small ${primary ? "btn-primary" : "btn-secondary"}`}
                      to={chatPathFor(siteId, thread)}
                    >
                      {actionLabel(thread)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="home-health card" aria-labelledby="home-health-heading">
          <div className="home-health-top">
            <h2 id="home-health-heading" className="section-title">
              Site health
            </h2>
            <Link to={`/site/${siteId}/diagnostics`}>Details</Link>
          </div>
          <ul className="health-list">
            <li>
              <span
                className={`status-dot tone-${active ? "done" : "waiting"}`}
                aria-hidden="true"
              />
              <span>
                <strong>Site</strong>
                <span className="muted">{activationLabel(site.activationStatus)}</span>
              </span>
            </li>
            <li>
              <span
                className={`status-dot tone-${discoveryRevision === null || discoveryReviewRequired ? "waiting" : "done"}`}
                aria-hidden="true"
              />
              <span>
                <strong>Discovery</strong>
                <span className="muted">
                  {discoveryRevision === null
                    ? "Not run yet"
                    : `Revision ${discoveryRevision}${discoveryReviewRequired ? " · review needed" : " · matches the site"}`}
                </span>
              </span>
            </li>
          </ul>
          {discoveryReviewRequired ? (
            <Link className="btn btn-secondary btn-small" to={`/site/${siteId}/config`}>
              Review discovery changes
            </Link>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
