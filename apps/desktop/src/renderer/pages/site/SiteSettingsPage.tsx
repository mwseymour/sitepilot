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
  SitePlannerSettings,
  UiPreferences,
  WordPressCoreBlockIndex
} from "@sitepilot/contracts";
import {
  WORDPRESS_CORE_BLOCK_REFERENCE_URL,
} from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

type GapComplexity = "simple" | "medium" | "complex";
type StructuralRole =
  | "standalone"
  | "container"
  | "child-only"
  | "placement-restricted";

function blockHasRelationshipRules(block: WordPressCoreBlockIndex["blocks"][number]): boolean {
  return (
    block.parent.length > 0 ||
    block.ancestor.length > 0 ||
    block.allowedBlocks.length > 0
  );
}

function classifyGapComplexity(
  block: WordPressCoreBlockIndex["blocks"][number]
): GapComplexity {
  const score =
    (block.renderPath ? 2 : 0) +
    (block.phpRegistrationPath ? 1 : 0) +
    (blockHasRelationshipRules(block) ? 1 : 0) +
    (block.attributes.length >= 8 ? 1 : 0) +
    (block.supports.length >= 8 ? 1 : 0);

  if (score >= 4) {
    return "complex";
  }
  if (score >= 2) {
    return "medium";
  }
  return "simple";
}

function complexityLabel(
  block: WordPressCoreBlockIndex["blocks"][number]
): string {
  const complexity = classifyGapComplexity(block);
  if (complexity === "complex") {
    return "Complex";
  }
  if (complexity === "medium") {
    return "Medium";
  }
  return "Simple";
}

function blockSignals(block: WordPressCoreBlockIndex["blocks"][number]): string {
  const signals: string[] = [];
  if (block.renderPath) {
    signals.push("render");
  }
  if (block.phpRegistrationPath) {
    signals.push("php");
  }
  if (block.canContainInnerBlocks) {
    signals.push("inner-blocks");
  }
  if (block.hasParentRestriction || block.hasAncestorRestriction) {
    signals.push("placement-rules");
  }
  if (signals.length === 0) {
    signals.push("static");
  }
  return signals.join(", ");
}

function classifyStructuralRole(
  block: WordPressCoreBlockIndex["blocks"][number]
): StructuralRole {
  if (block.canContainInnerBlocks) {
    return "container";
  }
  if (block.hasParentRestriction || block.hasAncestorRestriction) {
    if (block.parent.length > 0 && block.ancestor.length === 0) {
      return "child-only";
    }
    return "placement-restricted";
  }
  return "standalone";
}

function structuralRoleLabel(
  block: WordPressCoreBlockIndex["blocks"][number]
): string {
  const role = classifyStructuralRole(block);
  if (role === "container") {
    return "Container";
  }
  if (role === "child-only") {
    return "Child-only";
  }
  if (role === "placement-restricted") {
    return "Placement-restricted";
  }
  return "Standalone";
}

export function SiteSettingsPage(): ReactElement {
  const { siteId, data, loading } = useSiteWorkspace();
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasSecret, setHasSecret] = useState<boolean | null>(null);
  const [planner, setPlanner] = useState<PlannerPreferencesPayload | null>(
    null
  );
  const [uiPreferences, setUiPreferences] = useState<UiPreferences | null>(null);
  const [sitePlannerSettings, setSitePlannerSettings] =
    useState<SitePlannerSettings | null>(null);
  const [coreBlockIndex, setCoreBlockIndex] =
    useState<WordPressCoreBlockIndex | null>(null);
  const [wordpressCoreSourcePath, setWordPressCoreSourcePath] =
    useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const executableBlocks =
    coreBlockIndex?.blocks.filter((entry) => entry.executable) ?? [];
  const indexedOnlyBlocks =
    coreBlockIndex?.blocks.filter((entry) => !entry.executable) ?? [];
  const simpleGaps = indexedOnlyBlocks.filter(
    (entry) => classifyGapComplexity(entry) === "simple"
  );
  const mediumGaps = indexedOnlyBlocks.filter(
    (entry) => classifyGapComplexity(entry) === "medium"
  );
  const complexGaps = indexedOnlyBlocks.filter(
    (entry) => classifyGapComplexity(entry) === "complex"
  );
  const standaloneGaps = indexedOnlyBlocks.filter(
    (entry) => classifyStructuralRole(entry) === "standalone"
  );
  const containerGaps = indexedOnlyBlocks.filter(
    (entry) => classifyStructuralRole(entry) === "container"
  );
  const childOnlyGaps = indexedOnlyBlocks.filter(
    (entry) => classifyStructuralRole(entry) === "child-only"
  );
  const placementRestrictedGaps = indexedOnlyBlocks.filter(
    (entry) => classifyStructuralRole(entry) === "placement-restricted"
  );

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
    setUiPreferences(state.uiPreferences);
    setSitePlannerSettings(
      state.sitePlannerSettings ?? { bypassApprovalRequests: false }
    );
    setHasSecret(state.siteHasSigningSecret ?? false);
    setCoreBlockIndex(state.coreBlockIndex ?? null);
    setWordPressCoreSourcePath(state.wordpressCoreSourcePath ?? null);
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
    setHint("Developer tools setting saved.");
    await load();
  }

  async function onReindexCoreBlocks(): Promise<void> {
    setBusy(true);
    setErr(null);
    setHint(null);
    const res = await window.sitePilotDesktop.reindexCoreBlocks({});
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setCoreBlockIndex(res.coreBlockIndex ?? null);
    setHint(
      res.coreBlockIndex
        ? `Re-indexed ${res.coreBlockIndex.indexedBlockCount} core blocks from WordPress ${res.coreBlockIndex.wordpressVersion ?? "snapshot"}.`
        : "No local wordpress-core snapshot was found to index."
    );
  }

  async function onSaveWordPressCoreSourcePath(): Promise<void> {
    setBusy(true);
    setErr(null);
    setHint(null);
    const res = await window.sitePilotDesktop.setWordPressCoreSourcePath({
      path:
        wordpressCoreSourcePath !== null &&
        wordpressCoreSourcePath.trim().length > 0
          ? wordpressCoreSourcePath
          : null
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setWordPressCoreSourcePath(res.path ?? null);
    setHint(
      res.path
        ? "WordPress core source folder saved."
        : "WordPress core source folder cleared."
    );
    await load();
  }

  async function onChooseWordPressCoreSourcePath(): Promise<void> {
    setBusy(true);
    setErr(null);
    setHint(null);
    const res = await window.sitePilotDesktop.chooseWordPressCoreSourcePath({});
    setBusy(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    if (res.path) {
      setWordPressCoreSourcePath(res.path);
      setHint("WordPress core source folder selected.");
      await load();
    }
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
          Discovery check
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

      {uiPreferences ? (
        <section className="settings-site-section">
          <h2>UI preferences</h2>
          <p className="muted small-print">
            Show the developer diagnostics panel on the Requests page, including
            surfaced error messages, plan validation, and MCP request/response
            payloads.
          </p>
          <label className="settings-field">
            <span>Enable developer panel</span>
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
            When enabled, images stay at original quality instead of being
            resized and re-encoded before planning or upload.
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

      <section className="settings-site-section">
        <h2>Supported blocks</h2>
        <p className="muted small-print">
          Reference list:{" "}
          <a
            href={WORDPRESS_CORE_BLOCK_REFERENCE_URL}
            target="_blank"
            rel="noreferrer"
          >
            WordPress Core Blocks Reference
          </a>
          . Snapshot source: <code>{coreBlockIndex?.sourceRoot ?? "wordpress-core/"}</code>.
        </p>
        <p className="muted small-print">
          SitePilot indexes the local WordPress snapshot to discover core block
          metadata, but only executes blocks with explicit parsed-block
          canonicalization. Everything else stays blocked instead of saving
          guessed Gutenberg HTML.
        </p>
        <label className="settings-field">
          <span>WordPress core source folder</span>
          <input
            type="text"
            value={wordpressCoreSourcePath ?? ""}
            placeholder="/path/to/wordpress-core"
            disabled={busy}
            onChange={(e) => {
              setWordPressCoreSourcePath(e.target.value);
            }}
          />
        </label>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onChooseWordPressCoreSourcePath()}
          >
            Choose folder…
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onSaveWordPressCoreSourcePath()}
          >
            Save source folder
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onReindexCoreBlocks()}
          >
            Re-index block structures
          </button>
        </div>
        {coreBlockIndex ? (
          <>
            <p className="muted small-print">
              Indexed {coreBlockIndex.indexedBlockCount} blocks from WordPress{" "}
              {coreBlockIndex.wordpressVersion ?? "unknown"} on{" "}
              {new Date(coreBlockIndex.generatedAt).toLocaleString()}.
            </p>
            <details open>
              <summary>Executable ({executableBlocks.length})</summary>
              <ul className="small-print">
                {executableBlocks.map((entry) => (
                  <li key={entry.name}>
                    <strong>{entry.name}</strong>: {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary>Indexed only ({indexedOnlyBlocks.length})</summary>
              <ul className="small-print">
                {indexedOnlyBlocks.map((entry) => (
                  <li key={entry.name}>
                    <strong>{entry.name}</strong>: {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
            <details open>
              <summary>Gap Report ({indexedOnlyBlocks.length})</summary>
              <p className="muted small-print">
                Complexity is heuristic. It reflects render files, PHP
                registration, placement rules, inner-block allowances, and
                attribute/support count so we can see where serializer work is
                likely to be shallow or expensive.
              </p>
              <p className="muted small-print">
                Simple: {simpleGaps.length}. Medium: {mediumGaps.length}.
                Complex: {complexGaps.length}.
              </p>
              <p className="muted small-print">
                Standalone: {standaloneGaps.length}. Container:{" "}
                {containerGaps.length}. Child-only: {childOnlyGaps.length}.
                Placement-restricted: {placementRestrictedGaps.length}.
              </p>
              <details>
                <summary>Structural Roles</summary>
                <div className="settings-role-grid small-print">
                  <div>
                    <strong>Standalone</strong>
                    <p className="muted">
                      No child allowance and no placement restriction.
                    </p>
                    <p>{standaloneGaps.map((entry) => entry.name).join(", ")}</p>
                  </div>
                  <div>
                    <strong>Container</strong>
                    <p className="muted">
                      Explicitly allows direct child blocks.
                    </p>
                    <p>{containerGaps.map((entry) => entry.name).join(", ")}</p>
                  </div>
                  <div>
                    <strong>Child-only</strong>
                    <p className="muted">
                      Must live under specific parent blocks.
                    </p>
                    <p>{childOnlyGaps.map((entry) => entry.name).join(", ")}</p>
                  </div>
                  <div>
                    <strong>Placement-restricted</strong>
                    <p className="muted">
                      Constrained by ancestor rules or mixed placement logic.
                    </p>
                    <p>
                      {placementRestrictedGaps
                        .map((entry) => entry.name)
                        .join(", ")}
                    </p>
                  </div>
                </div>
              </details>
              <div className="settings-gap-table-wrap">
                <table className="settings-gap-table small-print">
                  <thead>
                    <tr>
                      <th>Block</th>
                      <th>Role</th>
                      <th>Complexity</th>
                      <th>Signals</th>
                      <th>Inner</th>
                      <th>Placement</th>
                      <th>Attrs</th>
                      <th>Supports</th>
                      <th>Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    {indexedOnlyBlocks.map((entry) => (
                      <tr key={entry.name}>
                        <td>
                          <strong>{entry.name}</strong>
                        </td>
                        <td>{structuralRoleLabel(entry)}</td>
                        <td>{complexityLabel(entry)}</td>
                        <td>{blockSignals(entry)}</td>
                        <td>
                          {entry.canContainInnerBlocks
                            ? `children: ${entry.allowedBlocks.length}`
                            : entry.likelyUsesInnerBlocks
                              ? "likely"
                              : "no"}
                        </td>
                        <td>
                          {entry.hasParentRestriction
                            ? `parent: ${entry.parent.length}`
                            : entry.hasAncestorRestriction
                              ? `ancestor: ${entry.ancestor.length}`
                              : "none"}
                        </td>
                        <td>{entry.attributes.length}</td>
                        <td>{entry.supports.length}</td>
                        <td>
                          <code>{entry.metadataPath}</code>
                          {entry.renderPath ? <>, <code>{entry.renderPath}</code></> : null}
                          {entry.phpRegistrationPath ? (
                            <>
                              , <code>{entry.phpRegistrationPath}</code>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            {coreBlockIndex.missingReferenceBlocks.length > 0 ? (
              <details>
                <summary>
                  Missing From Snapshot ({coreBlockIndex.missingReferenceBlocks.length})
                </summary>
                <p className="muted small-print">
                  {coreBlockIndex.missingReferenceBlocks.join(", ")}
                </p>
              </details>
            ) : null}
            {coreBlockIndex.additionalSnapshotBlocks.length > 0 ? (
              <details>
                <summary>
                  Additional Snapshot Blocks ({coreBlockIndex.additionalSnapshotBlocks.length})
                </summary>
                <p className="muted small-print">
                  {coreBlockIndex.additionalSnapshotBlocks.join(", ")}
                </p>
              </details>
            ) : null}
          </>
        ) : (
          <p className="muted small-print">
            No cached WordPress core block index found yet. Add or update the
            local <code>wordpress-core/</code> snapshot and run re-index.
          </p>
        )}
      </section>

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
