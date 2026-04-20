import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import { Link } from "react-router-dom";

import type {
  PlannerPreferencesPayload,
  SitePlannerSettings
} from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

export function SiteSettingsPage(): ReactElement {
  const { siteId, data, loading } = useSiteWorkspace();
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasSecret, setHasSecret] = useState<boolean | null>(null);
  const [planner, setPlanner] = useState<PlannerPreferencesPayload | null>(
    null
  );
  const [sitePlannerSettings, setSitePlannerSettings] =
    useState<SitePlannerSettings | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!data || data.site.activationStatus !== "active") {
      return;
    }
    const state = await window.sitePilotDesktop.getSettingsState({
      workspaceId: data.site.workspaceId,
      siteId
    });
    if (!state.ok) {
      setErr(state.message);
      return;
    }
    setErr(null);
    setPlanner(state.planner);
    setSitePlannerSettings(
      state.sitePlannerSettings ?? { bypassApprovalRequests: false }
    );
    setHasSecret(state.siteHasSigningSecret ?? false);
  }, [data, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onExport(): Promise<void> {
    setBusy(true);
    setErr(null);
    setHint(null);
    const res = await window.sitePilotDesktop.buildSiteExportBundle({ siteId });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    const blob = new Blob([res.bundleJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sitepilot-export-${siteId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setHint("Export downloaded (no secrets included).");
  }

  async function onImportFile(f: File): Promise<void> {
    const text = await f.text();
    setBusy(true);
    setErr(null);
    setHint(null);
    const res = await window.sitePilotDesktop.applySiteImportBundle({
      bundleJson: text
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setHint(
      `Imported ${res.auditsImported} audit rows and ${res.configsImported} config versions.`
    );
    await load();
  }

  async function onForgetSecret(): Promise<void> {
    if (
      !globalThis.confirm(
        "Remove the stored signing secret for this site? You will need to register again before MCP calls work."
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.clearSiteSigningSecret({
      siteId
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setHint("Site signing secret removed from secure storage.");
    await load();
  }

  async function onSaveWorkspacePlanner(): Promise<void> {
    if (!planner || !data) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.setPlannerPreferences({
      workspaceId: data.site.workspaceId,
      preferences: planner
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setHint("Workspace planner preferences saved.");
    await load();
  }

  async function onSaveSitePlannerSettings(): Promise<void> {
    if (!sitePlannerSettings) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.setSitePlannerSettings({
      siteId,
      settings: sitePlannerSettings
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setHint("Site approval bypass setting saved.");
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
        <h1>Site settings</h1>
        <p className="lede">Activate the site to manage trust and exports.</p>
        <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
          Site configuration
        </Link>
      </article>
    );
  }

  return (
    <article className="panel-card">
      <h1>Site settings</h1>
      <p className="lede">
        Plugin signing secret, workspace planner overrides, and data export /
        import for this site.
      </p>
      <p className="small-print">
        <Link to="/settings">Global provider keys</Link>
      </p>
      {err ? <p className="workspace-error">{err}</p> : null}
      {hint ? <p className="workspace-note small-print">{hint}</p> : null}

      <section className="settings-site-section">
        <h2>Plugin trust</h2>
        <p className="muted small-print">
          Signing secret present:{" "}
          {hasSecret === null ? "…" : hasSecret ? "yes" : "no"}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || hasSecret !== true}
          onClick={() => void onForgetSecret()}
        >
          Forget site signing secret
        </button>
      </section>

      {planner ? (
        <section className="settings-site-section">
          <h2>Planner overrides (workspace)</h2>
          <p className="muted small-print">
            Merges over global defaults for plans created under sites in this
            workspace.
          </p>
          <label className="settings-field">
            <span>Preferred provider</span>
            <select
              value={planner.preferredProvider}
              disabled={busy}
              onChange={(e) => {
                setPlanner({
                  ...planner,
                  preferredProvider: e.target
                    .value as PlannerPreferencesPayload["preferredProvider"]
                });
              }}
            >
              <option value="auto">Auto</option>
              <option value="openai">OpenAI first</option>
              <option value="anthropic">Anthropic first</option>
            </select>
          </label>
          <label className="settings-field">
            <span>OpenAI model</span>
            <input
              type="text"
              value={planner.openaiModel}
              disabled={busy}
              onChange={(e) => {
                setPlanner({ ...planner, openaiModel: e.target.value });
              }}
            />
          </label>
          <label className="settings-field">
            <span>Anthropic model</span>
            <input
              type="text"
              value={planner.anthropicModel}
              disabled={busy}
              onChange={(e) => {
                setPlanner({ ...planner, anthropicModel: e.target.value });
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onSaveWorkspacePlanner()}
          >
            Save workspace planner preferences
          </button>
        </section>
      ) : null}

      {sitePlannerSettings ? (
        <section className="settings-site-section">
          <h2>Approvals (site)</h2>
          <p className="muted small-print">
            Lets this site skip approval queues when plan validation would
            otherwise require operator approval.
          </p>
          <label className="settings-field">
            <span>Approval bypass</span>
            <input
              type="checkbox"
              checked={sitePlannerSettings.bypassApprovalRequests}
              disabled={busy}
              onChange={(e) => {
                setSitePlannerSettings({
                  bypassApprovalRequests: e.target.checked
                });
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onSaveSitePlannerSettings()}
          >
            Save site approval setting
          </button>
        </section>
      ) : null}

      <section className="settings-site-section">
        <h2>Export &amp; import</h2>
        <p className="muted small-print">
          Bundle includes site metadata, config versions, and audit history.
          Import appends audits and missing config versions; it does not remove
          existing rows.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onExport()}
          >
            Download export
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Import bundle…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) {
                void onImportFile(f);
              }
            }}
          />
        </div>
      </section>
    </article>
  );
}
