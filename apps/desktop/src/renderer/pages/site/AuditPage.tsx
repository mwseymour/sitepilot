import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import type { AuditLogEntry } from "@sitepilot/contracts";
import { auditEventTypes } from "@sitepilot/domain";

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
  const [requestFilter, setRequestFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [eventPick, setEventPick] = useState<string>("");
  const [executionOutcome, setExecutionOutcome] = useState<
    "any" | "failed" | "succeeded"
  >("any");
  const [rollbackOnly, setRollbackOnly] = useState(false);

  const load = useCallback(async () => {
    const req = {
      siteId,
      limit: 250,
      ...(requestFilter.trim().length > 0
        ? { requestId: requestFilter.trim() }
        : {}),
      ...(actionFilter.trim().length > 0
        ? { actionId: actionFilter.trim() }
        : {}),
      ...(since.trim().length > 0 ? { since: since.trim() } : {}),
      ...(until.trim().length > 0 ? { until: until.trim() } : {}),
      ...(eventPick.length > 0
        ? {
            eventTypes: [eventPick as (typeof auditEventTypes)[number]]
          }
        : {}),
      ...(executionOutcome !== "any" ? { executionOutcome } : {}),
      ...(rollbackOnly ? { rollbackRelatedOnly: true } : {})
    };

    const res = await window.sitePilotDesktop.listAuditEntries(req);
    if (!res.ok) {
      setErr(res.message);
      setEntries([]);
      return;
    }
    setErr(null);
    setEntries(res.entries);
  }, [
    siteId,
    requestFilter,
    actionFilter,
    since,
    until,
    eventPick,
    executionOutcome,
    rollbackOnly
  ]);

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
        Immutable history with filters by request, action, event type, time
        range, execution outcome, and rollback snapshots (T31).
      </p>
      <p className="small-print">
        <Link to={`/site/${siteId}/chat`}>Open chat</Link>
        {" · "}
        <Link to={`/site/${siteId}/settings`}>Site settings (export)</Link>
      </p>
      {err ? <p className="workspace-error">{err}</p> : null}

      <div className="audit-filters">
        <label className="audit-filter-field">
          Request id
          <input
            type="text"
            value={requestFilter}
            placeholder="optional"
            onChange={(e) => {
              setRequestFilter(e.target.value);
            }}
          />
        </label>
        <label className="audit-filter-field">
          Action id
          <input
            type="text"
            value={actionFilter}
            placeholder="optional"
            onChange={(e) => {
              setActionFilter(e.target.value);
            }}
          />
        </label>
        <label className="audit-filter-field">
          Event type
          <select
            value={eventPick}
            onChange={(e) => {
              setEventPick(e.target.value);
            }}
          >
            <option value="">Any</option>
            {auditEventTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="audit-filter-field">
          Since (ISO)
          <input
            type="text"
            value={since}
            placeholder="2026-04-01T00:00:00.000Z"
            onChange={(e) => {
              setSince(e.target.value);
            }}
          />
        </label>
        <label className="audit-filter-field">
          Until (ISO)
          <input
            type="text"
            value={until}
            placeholder="2026-04-30T23:59:59.999Z"
            onChange={(e) => {
              setUntil(e.target.value);
            }}
          />
        </label>
        <label className="audit-filter-field">
          Execution result
          <select
            value={executionOutcome}
            onChange={(e) => {
              setExecutionOutcome(e.target.value as typeof executionOutcome);
            }}
          >
            <option value="any">Any</option>
            <option value="succeeded">Succeeded (completed / tool)</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label className="audit-filter-check">
          <input
            type="checkbox"
            checked={rollbackOnly}
            onChange={(e) => {
              setRollbackOnly(e.target.checked);
            }}
          />
          Rollback snapshots only
        </label>
      </div>

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
          Apply filters
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="muted">No audit entries match these filters.</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Request</th>
              <th>Action</th>
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
                <td>
                  {e.requestId ? (
                    <Link
                      className="small-print"
                      to={`/site/${siteId}/chat`}
                      title="Open chat for follow-up"
                    >
                      {e.requestId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{e.actionId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
