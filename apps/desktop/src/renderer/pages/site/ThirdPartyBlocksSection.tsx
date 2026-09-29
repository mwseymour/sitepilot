import { useState, type ReactElement } from "react";

import type {
  GutenbergV2ThirdPartyReport,
  GutenbergV2ThirdPartyReportBlock
} from "@sitepilot/contracts";

import { useAppBusy } from "../../button-loading.js";

const OUTCOME_LABELS: Record<
  GutenbergV2ThirdPartyReportBlock["probe"]["outcome"],
  string
> = {
  builds_cleanly: "Builds cleanly",
  changes_on_round_trip: "Changes when reopened",
  changes_when_edited: "Its editor changes settings",
  invalid: "Markup changes on re-save",
  error: "Could not be built",
  not_tested: "Not tested"
};

function statusLabel(block: GutenbergV2ThirdPartyReportBlock): string {
  switch (block.readiness) {
    case "needs_definition":
      return "Kept · ready for a definition";
    case "needs_attention":
      return "Kept · check the test result";
    case "inside_block":
      return block.parents.length > 0
        ? `Kept · only inside ${block.parents[0]}${block.parents.length > 1 ? ` (+${block.parents.length - 1})` : ""}`
        : "Kept · only inside another block";
    case "hidden":
      return block.placement === "not_allowed"
        ? "Kept · not allowed in this editor"
        : "Kept · hidden from the inserter";
  }
}

function outputLabel(block: GutenbergV2ThirdPartyReportBlock): string {
  if (block.rendering === "saved_markup") return "Saves its own HTML";
  if (block.probe.preview === "rendered") return "Server · preview rendered";
  if (block.probe.preview === "failed") return "Server · preview failed";
  return "Rendered by the server";
}

function BlockRow({
  block
}: {
  block: GutenbergV2ThirdPartyReportBlock;
}): ReactElement {
  const example = block.usage.examples[0];
  return (
    <tr>
      <td>
        <strong>{block.title}</strong>
        <span className="third-party-meta">
          <code>{block.name}</code>
        </span>
        {block.settings.length > 0 || example ? (
          <details className="third-party-details">
            <summary>
              {block.settings.length} setting
              {block.settings.length === 1 ? "" : "s"}
              {example ? " · example from this site" : ""}
            </summary>
            {block.settings.length > 0 ? (
              <ul>
                {block.settings.map((setting) => (
                  <li key={setting.name}>
                    <code>{setting.name}</code>
                    {setting.type ? ` ${setting.type}` : ""}
                    {setting.enum && setting.enum.length > 0
                      ? ` (${setting.enum
                          .map((value) => (value === "" ? '""' : String(value)))
                          .join(", ")})`
                      : ""}
                    {setting.default !== undefined
                      ? ` · default ${setting.default}`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {example ? (
              <>
                <p className="muted small-print">From post {example.postId}:</p>
                <pre>{example.attributes}</pre>
              </>
            ) : null}
          </details>
        ) : null}
      </td>
      <td>
        {block.usage.posts > 0
          ? `${block.usage.posts} post${block.usage.posts === 1 ? "" : "s"}`
          : "—"}
      </td>
      <td>{outputLabel(block)}</td>
      <td>
        {OUTCOME_LABELS[block.probe.outcome]}
        {block.probe.message ? (
          <span className="third-party-meta">{block.probe.message}</span>
        ) : null}
        {block.probe.previewMessage ? (
          <span className="third-party-meta">
            Preview: {block.probe.previewMessage}
          </span>
        ) : null}
      </td>
      <td>{statusLabel(block)}</td>
    </tr>
  );
}

/**
 * Read-only report of the site's third-party (non-core, non-ACF) blocks:
 * which are worth supporting, whether this site's editor builds them
 * cleanly, and how existing content uses them. SitePilot keeps all of them
 * untouched; nothing is saved by the test.
 */
export function ThirdPartyBlocksSection({
  siteId
}: {
  siteId: string;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  useAppBusy(busy);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<GutenbergV2ThirdPartyReport | null>(
    null
  );
  const [showAll, setShowAll] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await window.sitePilotDesktop.testThirdPartyBlocks({ siteId });
      if (!res.ok) setErr(res.message);
      else setReport(res.report);
    } catch {
      setErr("The third-party block test failed to run.");
    } finally {
      setBusy(false);
    }
  }

  const topLevel =
    report?.blocks.filter((block) => block.placement === "top_level") ?? [];
  const inside =
    report?.blocks.filter((block) => block.placement === "inside_block")
      .length ?? 0;
  const hidden = (report?.blocks.length ?? 0) - topLevel.length - inside;
  const shown = showAll ? (report?.blocks ?? []) : topLevel;

  return (
    <section className="third-party-blocks">
      <div className="third-party-blocks-head">
        <div>
          <h2>Third-party blocks</h2>
          <p className="muted">
            Plugin blocks other than ACF blocks are kept untouched. This test
            shows which are worth supporting: it builds each block in this
            site&apos;s editor, reopens it, and counts how the site&apos;s posts
            and pages use it. It saves nothing.
          </p>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void run()}
          >
            {report ? "Test third-party blocks again" : "Test third-party blocks"}
          </button>
        </div>
      </div>
      {err ? <p className="workspace-error">{err}</p> : null}
      {report ? (
        report.blocks.length === 0 ? (
          <p className="muted">This site has no third-party blocks.</p>
        ) : (
          <>
            <p className="muted small-print">
              {topLevel.length} can go anywhere in a post · {inside} only
              inside other blocks · {hidden} hidden or not allowed · scanned{" "}
              {report.scannedPosts} post{report.scannedPosts === 1 ? "" : "s"}
              {report.usageTruncated ? " (the most recently changed)" : ""}
              {report.probeTimedOut
                ? " · the editor test hit its time limit, so some blocks were not tested"
                : ""}
            </p>
            <div className="settings-gap-table-wrap">
              <table className="settings-gap-table third-party-table">
                <thead>
                  <tr>
                    <th>Block</th>
                    <th>Used in</th>
                    <th>Output</th>
                    <th>Editor test</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((block) => (
                    <BlockRow key={block.name} block={block} />
                  ))}
                </tbody>
              </table>
            </div>
            {report.blocks.length > topLevel.length ? (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll
                  ? `Show only the ${topLevel.length} top-level blocks`
                  : `Show all ${report.blocks.length} blocks`}
              </button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
