import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import type { ApprovalSummary } from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

type ApprovalRow = ApprovalSummary;

export function ApprovalsPage(): ReactElement {
  const { siteId, data, loading } = useSiteWorkspace();
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastThreadId, setLastThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await window.sitePilotDesktop.listPendingApprovals({ siteId });
    if (!res.ok) {
      setErr(res.message);
      setApprovals([]);
      return;
    }
    setErr(null);
    setApprovals(res.approvals);
  }, [siteId]);

  useEffect(() => {
    if (!data || data.site.activationStatus !== "active") {
      return;
    }
    void load();
  }, [data, load]);

  async function onDecide(
    approvalRequestId: string,
    decision: "approved" | "rejected" | "revision_requested"
  ): Promise<void> {
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await window.sitePilotDesktop.decideApproval({
      siteId,
      approvalRequestId,
      decision
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    const approval = approvals.find((row) => row.id === approvalRequestId);
    setLastThreadId(approval?.threadId ?? null);
    setMessage(
      decision === "approved"
        ? "Approval recorded. Open Chat to use the plan controls."
        : decision === "revision_requested"
          ? "Revision requested. Open Chat to update the request or regenerate the plan."
          : "Approval rejected."
    );
    await load();
  }

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  if (data.site.activationStatus !== "active") {
    return (
      <article className="panel-card gate-card">
        <h1>Approvals</h1>
        <p className="lede">
          Activate this site before you can review approval requests.
        </p>
      </article>
    );
  }

  return (
    <article className="panel-card">
      <h1>Approvals</h1>
      <p className="lede">
        Pending items for high-risk or policy-gated plans. Decisions are
        recorded in the immutable audit log.
      </p>
      {message ? (
        <p className="success-note">
          {message}{" "}
          {lastThreadId ? (
            <Link to={`/site/${siteId}/chat`}>Open chat</Link>
          ) : null}
        </p>
      ) : null}
      {err ? <p className="workspace-error">{err}</p> : null}
      <div className="approvals-toolbar">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      {approvals.length === 0 ? (
        <p className="muted">No pending approvals for this site.</p>
      ) : (
        <ul className="approval-list">
          {approvals.map((a) => (
            <li key={a.id} className="approval-card">
              <header>
                <span className="approval-id">
                  {a.requestPrompt ?? "Approval request"}
                </span>
              </header>
              <p className="muted small-print">
                Request {a.requestId}
                {" · "}
                Plan {a.planId}
                {a.expiresAt ? (
                  <>
                    {" "}
                    · expires <time dateTime={a.expiresAt}>{a.expiresAt}</time>
                  </>
                ) : null}
              </p>
              <div className="approval-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={busy}
                  onClick={() => void onDecide(a.id, "approved")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busy}
                  onClick={() => void onDecide(a.id, "revision_requested")}
                >
                  Request revision
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busy}
                  onClick={() => void onDecide(a.id, "rejected")}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
