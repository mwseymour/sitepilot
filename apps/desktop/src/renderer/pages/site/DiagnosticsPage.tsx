import { useState, type ReactElement } from "react";

import type { ConnectivityDiagnosticsResult } from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

export function DiagnosticsPage(): ReactElement {
  const { siteId, data, reload } = useSiteWorkspace();
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<ConnectivityDiagnosticsResult | null>(null);
  const [discoveryMsg, setDiscoveryMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function runDiagnostics(): Promise<void> {
    setBusy(true);
    setErr(null);
    setDiscoveryMsg(null);
    try {
      const res = await window.sitePilotDesktop.runSiteDiagnostics({ siteId });
      setDiag(res);
    } catch {
      setErr("Diagnostics failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runDiscovery(): Promise<void> {
    setBusy(true);
    setErr(null);
    setDiscoveryMsg(null);
    try {
      const res = await window.sitePilotDesktop.refreshSiteDiscovery({
        siteId
      });
      if (!res.ok) {
        setErr(res.message);
      } else {
        await reload();
        setDiscoveryMsg(
          data?.siteConfig
            ? `Discovery snapshot saved (revision ${res.snapshot.revision}). Review the discovery check to sync the saved setup.`
            : `Discovery snapshot saved (revision ${res.snapshot.revision}). Generate a draft from discovery next.`
        );
      }
    } catch {
      setErr("Discovery refresh failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel-card">
      <h1>Diagnostics</h1>
      <p className="lede">
        Check reachability, protocol compatibility, MCP tools, and plugin
        metadata for this site.
      </p>
      <div className="action-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void runDiagnostics()}
        >
          Run connectivity diagnostics
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void runDiscovery()}
        >
          Refresh discovery
        </button>
      </div>
      {err ? <p className="workspace-error">{err}</p> : null}
      {discoveryMsg ? <p className="success-note">{discoveryMsg}</p> : null}
      {diag ? (
        <pre className="diag-json">{JSON.stringify(diag, null, 2)}</pre>
      ) : null}
    </article>
  );
}
