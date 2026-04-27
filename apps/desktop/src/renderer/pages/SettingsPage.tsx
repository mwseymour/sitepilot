import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import type {
  PlannerPreferencesPayload,
  UiPreferences
} from "@sitepilot/contracts";

export function SettingsPage(): ReactElement {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [compat, setCompat] = useState<string | null>(null);
  const [providers, setProviders] = useState<
    { provider: string; label: string; isDefault: boolean }[]
  >([]);
  const [planner, setPlanner] = useState<PlannerPreferencesPayload | null>(
    null
  );
  const [uiPreferences, setUiPreferences] = useState<UiPreferences | null>(null);
  const [openaiSecret, setOpenaiSecret] = useState("");
  const [anthropicSecret, setAnthropicSecret] = useState("");

  const load = useCallback(async () => {
    const [state, c] = await Promise.all([
      window.sitePilotDesktop.getSettingsState({}),
      window.sitePilotDesktop.getCompatibilityInfo()
    ]);
    setCompat(
      `App ${c.appVersion} · Electron ${c.electronVersion} · protocol ${c.sitepilotProtocolVersion} (plugins ≥ ${c.minPluginProtocolVersion})`
    );
    if (!state.ok) {
      setErr(state.message);
      return;
    }
    setErr(null);
    setProviders(state.configuredProviders);
    setPlanner(state.planner);
    setUiPreferences(state.uiPreferences);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSaveOpenai(): Promise<void> {
    if (openaiSecret.trim().length === 0) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.setProviderSecret({
      provider: "openai",
      secret: openaiSecret.trim()
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setOpenaiSecret("");
    await load();
  }

  async function onSaveAnthropic(): Promise<void> {
    if (anthropicSecret.trim().length === 0) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.setProviderSecret({
      provider: "anthropic",
      secret: anthropicSecret.trim()
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setAnthropicSecret("");
    await load();
  }

  async function onClear(provider: "openai" | "anthropic"): Promise<void> {
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.clearProviderSecret({ provider });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await load();
  }

  async function onSavePlanner(): Promise<void> {
    if (!planner) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.setPlannerPreferences({
      preferences: planner
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await load();
  }

  async function onSaveUiPreferences(): Promise<void> {
    if (!uiPreferences) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.setUiPreferences({
      preferences: uiPreferences
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    await load();
  }

  return (
    <main className="app-shell home-shell">
      <section className="hero-card">
        <p className="eyebrow">SitePilot</p>
        <h1>Settings</h1>
        <p className="lede">
          Provider keys stay in OS-backed secure storage; the renderer never
          receives secret values back from the app.
        </p>
        <Link className="btn btn-secondary btn-small" to="/">
          ← Sites
        </Link>
      </section>
      {err ? <p className="workspace-error">{err}</p> : null}
      {compat ? <p className="muted small-print">{compat}</p> : null}

      {uiPreferences ? (
        <section className="panel-card">
          <h2>UI preferences</h2>
          <p className="muted small-print">
            Show the diagnostics panel on the Requests page, including planner
            validation, MCP payloads, and surfaced error messages.
          </p>
          <label className="settings-field">
            <span>Enable developer tools</span>
            <input
              type="checkbox"
              checked={uiPreferences.developerToolsEnabled}
              disabled={busy}
              onChange={(e) => {
                setUiPreferences({
                  ...uiPreferences,
                  developerToolsEnabled: e.target.checked
                });
              }}
            />
          </label>
          <label className="settings-field">
            <span>Preserve original image uploads</span>
            <input
              type="checkbox"
              checked={uiPreferences.preserveOriginalImageUploads}
              disabled={busy}
              onChange={(e) => {
                setUiPreferences({
                  ...uiPreferences,
                  preserveOriginalImageUploads: e.target.checked
                });
              }}
            />
          </label>
          <p className="muted small-print">
            When enabled, attached images keep their original bytes and MIME
            type instead of being resized and re-encoded before planning or
            upload.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onSaveUiPreferences()}
          >
            Save UI preferences
          </button>
        </section>
      ) : null}

      <section className="panel-card">
        <h2>Configured providers</h2>
        {providers.length === 0 ? (
          <p className="muted">No API keys stored yet.</p>
        ) : (
          <ul className="small-print">
            {providers.map((p) => (
              <li key={p.provider}>
                {p.label} {p.isDefault ? "(default slot)" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-card">
        <h2>OpenAI API key</h2>
        <input
          type="password"
          autoComplete="off"
          className="settings-input"
          placeholder="sk-…"
          value={openaiSecret}
          onChange={(e) => {
            setOpenaiSecret(e.target.value);
          }}
        />
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || openaiSecret.trim().length === 0}
            onClick={() => void onSaveOpenai()}
          >
            Save key
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onClear("openai")}
          >
            Remove key
          </button>
        </div>
      </section>

      <section className="panel-card">
        <h2>Anthropic API key</h2>
        <input
          type="password"
          autoComplete="off"
          className="settings-input"
          placeholder="sk-ant-…"
          value={anthropicSecret}
          onChange={(e) => {
            setAnthropicSecret(e.target.value);
          }}
        />
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || anthropicSecret.trim().length === 0}
            onClick={() => void onSaveAnthropic()}
          >
            Save key
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onClear("anthropic")}
          >
            Remove key
          </button>
        </div>
      </section>

      {planner ? (
        <section className="panel-card">
          <h2>Planner defaults</h2>
          <p className="muted small-print">
            Used when generating action plans. Workspace-specific overrides can
            be set per site under Site settings.
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
              <option value="auto">Auto (OpenAI first, then Anthropic)</option>
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
            onClick={() => void onSavePlanner()}
          >
            Save planner preferences
          </button>
        </section>
      ) : null}
    </main>
  );
}
