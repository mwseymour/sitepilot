import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement
} from "react";
import { Link } from "react-router-dom";

import type {
  ipcChannels,
  ApprovalSummary,
  IpcResponse
} from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";
import {
  GutenbergV2CandidatePanel,
  type ReviewArtifact
} from "./GutenbergV2CandidatePanel.js";
import { useAppBusy } from "../../button-loading.js";

const SHOW_V1_APPROVALS = false;

type ApprovalRow = ApprovalSummary;
type GutenbergV2PendingResponse = IpcResponse<
  typeof ipcChannels.gutenbergV2ListPendingCandidates
>;
type GutenbergV2PendingCandidate = Extract<
  GutenbergV2PendingResponse,
  { ok: true }
>["candidates"][number];

export function ApprovalsPage(): ReactElement | null {
  const { siteId, data, loading } = useSiteWorkspace();
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [v2Candidates, setV2Candidates] = useState<
    GutenbergV2PendingCandidate[]
  >([]);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastThreadId, setLastThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useAppBusy(busy);

  const load = useCallback(async () => {
    const [res, v2Res] = await Promise.all([
      window.sitePilotDesktop.listPendingApprovals({ siteId }),
      window.sitePilotDesktop.gutenbergV2ListPendingCandidates({ siteId })
    ]);
    const errors: string[] = [];
    if (!res.ok) {
      errors.push(res.message);
      setApprovals([]);
    } else {
      setApprovals(res.approvals);
    }
    if (!v2Res.ok) {
      errors.push(v2Res.message);
      setV2Candidates([]);
    } else {
      setV2Candidates(v2Res.candidates);
    }
    setErr(errors.length > 0 ? errors.join(" ") : null);
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

  async function onDecideV2(
    candidate: GutenbergV2PendingCandidate,
    decision: "approved" | "rejected" | "revision_requested",
    note?: string
  ): Promise<void> {
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await window.sitePilotDesktop.gutenbergV2DecideCandidate({
      siteId,
      requestId: candidate.requestId,
      candidateId: candidate.candidate?.candidateId ?? "",
      decision,
      ...(note !== undefined ? { note } : {})
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setMessage(
      decision === "approved"
        ? "Native editor candidate approved. Open Chat to continue execution."
        : decision === "revision_requested"
          ? "Native editor candidate sent back for revision."
          : "Native editor candidate rejected."
    );
    await load();
  }

  const onLoadV2Artifact = useCallback(
    async (
      candidate: GutenbergV2PendingCandidate,
      artifactId: string
    ): Promise<ReviewArtifact | null> => {
      const res = await window.sitePilotDesktop.gutenbergV2GetReviewArtifact({
        siteId,
        requestId: candidate.requestId,
        artifactId
      });
      if (!res.ok) {
        setErr(res.message);
        return null;
      }
      return res.artifact;
    },
    [siteId]
  );

  const v2ArtifactLoaders = useMemo(
    () =>
      new Map(
        v2Candidates.map((candidate) => [
          candidate.requestId,
          (artifactId: string) => onLoadV2Artifact(candidate, artifactId)
        ])
      ),
    [onLoadV2Artifact, v2Candidates]
  );

  const onExecuteV2 = useCallback(
    async (candidate: GutenbergV2PendingCandidate): Promise<void> => {
      setBusy(true);
      setErr(null);
      const res = await window.sitePilotDesktop.gutenbergV2ExecuteCandidate({
        siteId,
        requestId: candidate.requestId
      });
      setBusy(false);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setMessage(
        res.state.state === "succeeded"
          ? "Native editor update completed and was verified."
          : "Native editor execution status refreshed."
      );
      await load();
    },
    [load, siteId]
  );

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

  // v1 plan approvals remain in the codebase but are no longer shown; the
  // native editor candidates are the only approval flow in the UI.
  const visibleApprovals = SHOW_V1_APPROVALS ? approvals : [];

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
      {visibleApprovals.length === 0 && v2Candidates.length === 0 ? (
        <p className="muted">No pending approvals for this site.</p>
      ) : (
        <>
          {v2Candidates.length > 0 ? (
            <section className="approval-section">
              <h2>Native editor candidates</h2>
              <p className="muted small-print">
                Every candidate is tied to its exact compiled content and needs
                an explicit decision, even when approval bypass is enabled.
              </p>
              <ul className="approval-list">
                {v2Candidates.map((candidate) => (
                  <li key={candidate.requestId} className="approval-card">
                    <GutenbergV2CandidatePanel
                      candidate={candidate}
                      busy={busy}
                      onDecide={(candidateId, decision, note) =>
                        onDecideV2(candidate, decision, note)
                      }
                      onExecute={() => onExecuteV2(candidate)}
                      onLoadArtifact={
                        v2ArtifactLoaders.get(candidate.requestId)!
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {visibleApprovals.length > 0 ? (
            <ul className="approval-list">
              {visibleApprovals.map((a) => (
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
                        · expires{" "}
                        <time dateTime={a.expiresAt}>{a.expiresAt}</time>
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
                      Approve plan
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
          ) : null}
        </>
      )}
    </article>
  );
}
