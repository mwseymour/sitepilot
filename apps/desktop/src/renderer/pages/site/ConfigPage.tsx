import { useEffect, useState, type ReactElement } from "react";

import type { SiteConfig } from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";
import { SiteConfigForm } from "./SiteConfigForm.js";

export function ConfigPage(): ReactElement | null {
  const { siteId, data, loading, reload } = useSiteWorkspace();
  const [draft, setDraft] = useState<SiteConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.siteConfig) {
      setDraft(data.siteConfig);
    } else {
      setDraft(null);
    }
  }, [data?.siteConfig]);

  async function onGenerateDraft(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.sitePilotDesktop.generateSiteConfigDraft({
        siteId
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setMessage("Draft saved from discovery snapshot.");
        await reload();
      }
    } catch {
      setError("Could not generate draft.");
    } finally {
      setBusy(false);
    }
  }

  async function onSave(): Promise<void> {
    if (!draft) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.sitePilotDesktop.saveSiteConfig({
        siteId,
        siteConfig: draft
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setDraft(res.siteConfig);
        setMessage("Configuration saved.");
        await reload();
      }
    } catch {
      setError("Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(): Promise<void> {
    if (!draft) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.sitePilotDesktop.confirmSiteConfig({
        siteId,
        configId: draft.id
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setDraft(res.siteConfig);
        setMessage("Site configuration confirmed. Chat can be enabled.");
        await reload();
      }
    } catch {
      setError("Confirmation failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="muted">Loading configuration…</p>;
  }

  if (!data) {
    return null;
  }

  const canActivate = draft ? draft.activationStatus !== "active" : false;

  return (
    <article className="panel-card config-page">
      <header className="panel-header">
        <div>
          <h1>Site configuration</h1>
          <p className="lede">
            Review sections populated from discovery, adjust policies, then
            save. When you are satisfied, confirm to activate the site (required
            before chat).
          </p>
        </div>
        <div className="action-row panel-actions">
          {data.siteConfig === null ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void onGenerateDraft()}
            >
              Generate draft from discovery
            </button>
          ) : null}
        </div>
      </header>
      {message ? <p className="success-note">{message}</p> : null}
      {error ? <p className="workspace-error">{error}</p> : null}
      {draft ? (
        <>
          <SiteConfigForm value={draft} onChange={setDraft} />
          <div className="action-row config-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void onSave()}
            >
              Save changes
            </button>
            {canActivate ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void onConfirm()}
              >
                Confirm &amp; activate site
              </button>
            ) : (
              <p className="muted inline-status">
                This configuration version is active.
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="muted">
          No configuration version yet. Run discovery from Diagnostics, then
          generate a first-pass draft here.
        </p>
      )}
    </article>
  );
}
