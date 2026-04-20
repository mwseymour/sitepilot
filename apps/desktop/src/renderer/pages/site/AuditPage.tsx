import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { AuditLogEntry } from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

type AuditRow = AuditLogEntry;

function actorLabel(row: AuditRow): string {
  if ("kind" in row.actor) {
    return row.actor.kind;
  }
  return row.actor.userProfileId;
}

export function AuditPage(): ReactElement {
  const { siteId, data, loading } = useSiteWorkspace();
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await window.sitePilotDesktop.listAuditEntries({
      siteId,
      limit: 250
    });
    if (!res.ok) {
      setErr(res.message);
      setEntries([]);
      return;
    }
    setErr(null);
    setEntries(res.entries);
  }, [siteId]);

  useEffect(() => {
    if (!data || data.site.activationStatus !== "active") {
      return;
    }
    void load();
  }, [data, load]);

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  if (data.site.activationStatus !== "active") {
    return (
      <article className="panel-card gate-card">
        <h1>Audit log</h1>
        <p className="lede">
          Activate this site to load audit entries for the workspace.
        </p>
      </article>
    );
  }

  return (
    <article className="panel-card">
      <h1>Audit log</h1>
      <p className="lede">
        Append-only history for requests, plans, validation, approvals, and
        related events (newest site-wide entries first).
      </p>
      {err ? <p className="workspace-error">{err}</p> : null}
      <div className="audit-toolbar">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load().finally(() => {
              setBusy(false);
            });
          }}
        >
          Refresh
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="muted">No audit entries yet for this site.</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Request</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>
                  <time dateTime={e.createdAt}>{e.createdAt}</time>
                </td>
                <td>{e.eventType}</td>
                <td>{actorLabel(e)}</td>
                <td>{e.requestId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
