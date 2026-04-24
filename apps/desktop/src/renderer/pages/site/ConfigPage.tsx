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
        setMessage("Draft saved from the latest discovery snapshot.");
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
        setMessage("Discovery check confirmed. Chat can be enabled.");
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
  const hasDiscovery = data.discoveryRevision !== null;
  const needsDiscoveryReview = data.discoveryReviewRequired;
  const generateLabel =
    draft === null
      ? "Generate draft from discovery"
      : needsDiscoveryReview
        ? "Regenerate draft from latest discovery"
        : "Generate fresh draft from discovery";

  return (
    <article className="panel-card config-page">
      <header className="panel-header">
        <div>
          <h1>Discovery check</h1>
          <p className="lede">
            Review the latest discovery snapshot against the saved site setup,
            regenerate the draft when discovery changes, then confirm the
            latest version before chat is enabled.
          </p>
          {draft ? (
            <p className="muted">
              {needsDiscoveryReview
                ? `Discovery revision ${data.discoveryRevision ?? "unknown"} is newer than this saved setup. Regenerate the draft and review changes.`
                : hasDiscovery
                  ? `Saved setup already reflects discovery revision ${data.discoveryRevision}.`
                  : "No discovery snapshot available yet."}
            </p>
          ) : null}
        </div>
        <div className="action-row panel-actions">
          {hasDiscovery ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void onGenerateDraft()}
            >
              {generateLabel}
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
                {needsDiscoveryReview
                  ? "An active setup exists, but a newer discovery snapshot needs review."
                  : "This reviewed setup is active."}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="muted">
          {hasDiscovery
            ? "No saved setup yet. Generate a first-pass draft from the latest discovery snapshot."
            : "No discovery snapshot yet. Run discovery from Diagnostics first."}
        </p>
      )}
    </article>
  );
}
