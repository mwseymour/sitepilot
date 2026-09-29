import { useState, type ReactElement } from "react";

import type {
  ConnectivityDiagnosticsResult,
  TestAcfBlocksResponse
} from "@sitepilot/contracts";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";
import { useAppBusy } from "../../button-loading.js";
import { formatWhen } from "../../status.js";
import { ThirdPartyBlocksSection } from "./ThirdPartyBlocksSection.js";

type CheckRow = { label: string; ok: boolean; detail: string };

function diagnosticRows(diag: ConnectivityDiagnosticsResult): CheckRow[] {
  const { health, protocolMetadata, authentication, mcpTools, pluginVersion } =
    diag.checks;
  const latency = (ms?: number): string => (ms === undefined ? "" : ` · ${ms} ms`);
  return [
    {
      label: "Site reachable",
      ok: health.ok,
      detail:
        health.message ??
        (health.ok
          ? `Responded${health.httpStatus ? ` with ${health.httpStatus}` : ""}${latency(health.latencyMs)}`
          : "The site didn’t respond")
    },
    {
      label: "Plugin protocol",
      ok: protocolMetadata.ok && protocolMetadata.compatibilityOk !== false,
      detail:
        protocolMetadata.compatibilityReason ??
        protocolMetadata.message ??
        [
          protocolMetadata.protocolVersion
            ? `Protocol ${protocolMetadata.protocolVersion}`
            : null,
          protocolMetadata.compatibilityOk ? "compatible with this app" : null
        ]
          .filter(Boolean)
          .join(" · ")
    },
    {
      label: "Signed requests",
      ok: authentication.ok,
      detail:
        authentication.message ??
        (authentication.ok
          ? "The site accepts this app’s signed requests"
          : "The site rejected this app’s signature")
    },
    {
      label: "Site tools",
      ok: mcpTools.ok,
      detail:
        mcpTools.message ??
        `${mcpTools.toolNames.length} ${mcpTools.toolNames.length === 1 ? "tool" : "tools"} available`
    },
    {
      label: "Plugin version",
      ok: pluginVersion.ok,
      detail:
        pluginVersion.message ??
        (pluginVersion.version ? `SitePilot plugin ${pluginVersion.version}` : "Unknown")
    }
  ];
}

function DiagnosticsResult({
  diag
}: {
  diag: ConnectivityDiagnosticsResult;
}): ReactElement {
  const rows = diagnosticRows(diag);
  const failing = rows.filter((row) => !row.ok).length;
  return (
    <section className="diagnostics-result card">
      <div className="diagnostics-result-top">
        <span
          className={`status-pill tone-${diag.overallOk ? "done" : "attention"}`}
        >
          {diag.overallOk
            ? "All checks passed"
            : `${failing} ${failing === 1 ? "check needs" : "checks need"} attention`}
        </span>
        <span className="muted small-print">
          Checked {formatWhen(diag.checkedAt)}
        </span>
      </div>
      <ul className="health-list diagnostics-checks">
        {rows.map((row) => (
          <li key={row.label}>
            <span
              className={`status-dot tone-${row.ok ? "done" : "attention"}`}
              aria-hidden="true"
            />
            <span>
              <strong>
                {row.label}
                <span className="visually-hidden">
                  {row.ok ? ": passed" : ": needs attention"}
                </span>
              </strong>
              <span className="muted">{row.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <details className="review-disclosure">
        <summary>Raw diagnostics report</summary>
        <pre>{JSON.stringify(diag, null, 2)}</pre>
      </details>
    </section>
  );
}

// Mirrors docs/v2-capabilities.md; update both together.
const WRITABLE_BLOCKS: Array<{ group: string; blocks: string }> = [
  {
    group: "Text",
    blocks: "Paragraph, heading, list, quote, pullquote, code, preformatted, details"
  },
  {
    group: "Layout",
    blocks: "Group, columns, separator, spacer, cover, accordion"
  },
  { group: "Media", blocks: "Image, gallery, media and text, video" },
  { group: "Embeds", blocks: "YouTube and Vimeo" },
  { group: "Other", blocks: "Buttons, table" }
];

function CapabilitiesSection({
  metaProvider
}: {
  metaProvider: "sitepilot" | "yoast" | null;
}): ReactElement {
  return (
    <section className="diagnostics-empty capabilities">
      <div>
        <h2>What SitePilot can change on this site</h2>
        <dl className="capability-list">
          {WRITABLE_BLOCKS.map((row) => (
            <div key={row.group}>
              <dt>{row.group}</dt>
              <dd>{row.blocks}</dd>
            </div>
          ))}
          <div>
            <dt>ACF blocks</dt>
            <dd>Only blocks that pass the ACF test below</dd>
          </div>
          <div>
            <dt>SEO</dt>
            <dd>
              {metaProvider === "yoast"
                ? "Yoast SEO title, meta description, focus keyphrase, canonical, indexing, social title and description"
                : "Needs Yoast SEO; this site’s discovery check doesn’t use it"}
            </dd>
          </div>
          <div>
            <dt>Post fields</dt>
            <dd>Title, excerpt, featured image, publish and unpublish</dd>
          </div>
        </dl>
        <p className="muted small-print">
          <strong>Kept exactly as it is:</strong> custom HTML, classic content,
          reusable blocks and other plugin blocks. SitePilot can move or delete
          these on purpose, but never edits them.
        </p>
        <p className="muted small-print">
          <strong>Not yet:</strong> categories and tags, scheduling, private
          posts, custom post types, slug, author and date.
        </p>
      </div>
    </section>
  );
}

export function DiagnosticsPage(): ReactElement {
  const { siteId, data, reload } = useSiteWorkspace();
  const [busy, setBusy] = useState(false);
  useAppBusy(busy);
  const [diag, setDiag] = useState<ConnectivityDiagnosticsResult | null>(null);
  const [discoveryMsg, setDiscoveryMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [acfResults, setAcfResults] = useState<
    Extract<TestAcfBlocksResponse, { ok: true }>["results"] | null
  >(null);

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

  async function testAcfBlocks(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await window.sitePilotDesktop.testAcfBlocks({ siteId });
      if (!res.ok) {
        setErr(res.message);
      } else {
        setAcfResults(res.results);
      }
    } catch {
      setErr("The ACF block test failed to run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel-card diagnostics-page">
      <header className="diagnostics-header">
        <div>
          <p className="eyebrow">Site health</p>
          <h1>Diagnostics</h1>
          <p className="lede">
            Check reachability, protocol compatibility, MCP tools, and plugin
            metadata for this site.
          </p>
        </div>
        <div className="diagnostics-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path
              d="M4 17.5h16M6 14l3.3-4 3.2 2.4L18 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </header>
      {err ? <p className="workspace-error">{err}</p> : null}
      {discoveryMsg ? <p className="success-note">{discoveryMsg}</p> : null}
      {diag ? (
        <DiagnosticsResult diag={diag} />
      ) : (
        <section className="diagnostics-empty">
          <div>
            <h2>No diagnostic run yet</h2>
            <p className="muted">
              Start with a connectivity check, or refresh discovery when the
              WordPress site structure has changed.
            </p>
          </div>
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
        </section>
      )}
      {diag ? (
        <div className="action-row diagnostics-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void runDiagnostics()}
          >
            Run again
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
      ) : null}
      <CapabilitiesSection
        metaProvider={data?.siteConfig?.sections.seoPolicy.metaProvider ?? null}
      />
      <section className="diagnostics-empty">
        <div>
          <h2>ACF blocks</h2>
          <p className="muted">
            SitePilot writes an ACF block only after it passes a save-and-reopen
            test in this site&apos;s editor. Until then, and again after its
            field group or ACF changes, the block is kept untouched. The test
            builds each block in a scratch editor and deletes its test draft.
          </p>
          {acfResults ? (
            acfResults.length === 0 ? (
              <p className="muted">This site has no ACF blocks to test.</p>
            ) : (
              <ul className="acf-block-results">
                {acfResults.map((result) => (
                  <li key={result.blockName}>
                    <code>{result.blockName}</code>{" "}
                    <strong>
                      {result.status === "passed"
                        ? "Passed, v2 can write it"
                        : result.status === "unsupported"
                          ? "Kept untouched (has fields v2 cannot fill)"
                          : "Failed, kept untouched"}
                    </strong>
                    {result.message ? ` — ${result.message}` : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void testAcfBlocks()}
          >
            {acfResults ? "Test ACF blocks again" : "Test ACF blocks"}
          </button>
        </div>
      </section>
      <ThirdPartyBlocksSection siteId={siteId} />
    </article>
  );
}
