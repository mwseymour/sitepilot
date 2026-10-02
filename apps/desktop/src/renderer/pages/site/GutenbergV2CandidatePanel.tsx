import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import type { ipcChannels, IpcResponse } from "@sitepilot/contracts";

import { formatWhen, minutesUntil, v2StateStatus } from "../../status.js";

type RequestStateResponse = IpcResponse<
  typeof ipcChannels.gutenbergV2GetRequestState
>;
type ReviewArtifactResponse = IpcResponse<
  typeof ipcChannels.gutenbergV2GetReviewArtifact
>;

export type GutenbergV2UiState = NonNullable<
  Extract<RequestStateResponse, { ok: true }>["state"]
>;
export type ReviewArtifact = Extract<
  ReviewArtifactResponse,
  { ok: true }
>["artifact"];

type Props = {
  /** The site's base URL: shown in the preview bar and used for editor links. */
  siteUrl?: string;
  /** Live progress or status shown above the review. */
  top?: ReactNode;
  /** Request details, shown folded at the end of the review. */
  children?: ReactNode;
  /** When the approval stops being valid, if the update is approved. */
  approvalExpiresAt?: string;
  candidate: GutenbergV2UiState;
  busy: boolean;
  onDecide: (
    candidateId: string,
    decision: "approved" | "rejected" | "revision_requested",
    note?: string
  ) => Promise<void>;
  onExecute: () => Promise<void>;
  onLoadArtifact: (artifactId: string) => Promise<ReviewArtifact | null>;
};

function operationLabel(target: GutenbergV2UiState["target"]): string {
  if (target.operation === "create_draft") {
    return `Create a new ${target.postType} draft`;
  }

  if (target.operation === "set_status") {
    return `${target.status === "publish" ? "Publish" : "Unpublish"} ${target.postType} #${target.postId}`;
  }
  const label =
    target.operation === "replace_content"
      ? "Replace all content"
      : "Apply selected changes";
  return `${label} on ${target.postType} #${target.postId ?? "unknown"}`;
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    planned: "Planning the update",
    compiling: "Building the update",
    review_ready: "Ready for review",
    approved: "Approved",
    preparing: "Preparing the update",
    committing: "Saving the update",
    verifying: "Verifying the saved content",
    succeeded: "Completed and verified",
    rejected: "Rejected",
    stale_approval: "Page changed since review",
    pre_write_failed: "Could not save the update",
    post_write_verification_failed: "Verification needs attention",
    rolled_back: "Rolled back safely",
    rollback_conflict: "Rollback needs attention",
    manual_intervention_required: "Needs attention"
  };
  return labels[state] ?? state.replaceAll("_", " ");
}

function terminalFailureGuidance(state: string): string | null {
  if (state === "stale_approval") {
    return "The page was edited in WordPress after you approved, so nothing was written. Reply in the thread to rebuild the update from the latest version.";
  }
  if (state === "pre_write_failed") {
    return "The update was not saved. Review the failure before starting a new candidate.";
  }
  if (state === "post_write_verification_failed") {
    return "The destination was written but could not be verified. Inspect the destination and use recovery when needed.";
  }
  return null;
}

function safePreviewSource(artifact: ReviewArtifact): string | null {
  if (
    artifact.kind !== "preview" ||
    artifact.mimeType !== "image/png" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.dataBase64)
  ) {
    return null;
  }
  return `data:image/png;base64,${artifact.dataBase64}`;
}

function decodeBase64Text(dataBase64: string): string {
  const bytes = Uint8Array.from(atob(dataBase64), (character) =>
    character.charCodeAt(0)
  );
  return new TextDecoder().decode(bytes);
}

function parseStructureArtifact(artifact: ReviewArtifact): unknown {
  return JSON.parse(decodeBase64Text(artifact.dataBase64));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type OutlineEntry = { depth: number; name: string; text: string };

const OUTLINE_TEXT_ATTRIBUTES = [
  "content",
  "text",
  "value",
  "citation",
  "alt",
  "caption",
  "mediaAlt",
  "summary",
  "title",
  "url"
];

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function blockOutline(blocks: unknown, depth = 0): OutlineEntry[] {
  if (!Array.isArray(blocks)) {
    return [];
  }
  return blocks.flatMap((block) => {
    const record = recordValue(block);
    if (!record || typeof record.name !== "string") {
      return [];
    }
    const attributes = recordValue(record.attributes) ?? {};
    if (record.name === "sitepilot/source-block") {
      return [
        {
          depth,
          name: "kept",
          text: `existing block at ${blockPathLabel(attributes.path)}, unchanged`
        }
      ];
    }
    const textAttribute = OUTLINE_TEXT_ATTRIBUTES.find(
      (key) => typeof attributes[key] === "string" && attributes[key] !== ""
    );
    const level =
      record.name === "core/heading" && typeof attributes.level === "number"
        ? `H${attributes.level} `
        : "";
    const text = textAttribute
      ? plainText(attributes[textAttribute] as string)
      : "";
    return [
      {
        depth,
        name: record.name.replace(/^core\//, ""),
        text: `${level}${text}`.trim()
      },
      ...blockOutline(record.children, depth + 1)
    ];
  });
}

function planBlocks(side: unknown): unknown {
  const record = recordValue(side);
  if (!record) {
    return undefined;
  }
  const plan = recordValue(record.plan);
  return plan?.blocks ?? record.blocks;
}

function blockPathLabel(path: unknown): string {
  return Array.isArray(path) && path.length > 0
    ? `position ${path.map((index) => Number(index) + 1).join(" › ")}`
    : "the top level";
}

/** Existing post structure from the trusted source block index. */
function sourceIndexOutline(side: unknown): OutlineEntry[] {
  const record = recordValue(side);
  if (!record || !Array.isArray(record.blockIndex)) {
    return blockOutline(planBlocks(side));
  }
  return record.blockIndex.flatMap((entry) => {
    const item = recordValue(entry);
    if (!item || typeof item.name !== "string" || !Array.isArray(item.path)) {
      return [];
    }
    const kept =
      item.role === "preserved"
        ? ` · kept unchanged${typeof item.summary === "string" && item.summary ? `: ${item.summary}` : ""}`
        : "";
    return [
      {
        depth: Math.max(0, item.path.length - 1),
        name: item.name.replace(/^core\//, ""),
        text: `${blockPathLabel(item.path)}${kept}`
      }
    ];
  });
}

type ChangeKind = "insert" | "edit" | "remove" | "move";

type ChangeSummary = {
  kind: ChangeKind;
  label: string;
  blocks: OutlineEntry[];
};

const CHANGE_MARK: Record<ChangeKind, { glyph: string; label: string }> = {
  insert: { glyph: "+", label: "Added" },
  edit: { glyph: "~", label: "Edited" },
  move: { glyph: "↕", label: "Moved" },
  remove: { glyph: "−", label: "Removed" }
};

function ChangeRow({ change }: { change: ChangeSummary }): ReactElement {
  const mark = CHANGE_MARK[change.kind];
  return (
    <li className="review-change">
      <span
        className={`review-change-mark is-${change.kind}`}
        aria-label={mark.label}
        title={mark.label}
      >
        {mark.glyph}
      </span>
      <div className="review-change-body">
        <p className="review-change-label">{change.label}</p>
        {change.blocks.length > 0 ? <BlockList entries={change.blocks} /> : null}
      </div>
    </li>
  );
}

const BLOCK_WORDS: Record<string, string> = {
  "media-text": "media and text block",
  "embed": "embed",
  "core-embed/youtube": "YouTube embed",
  "core-embed/vimeo": "Vimeo embed"
};

function blockWord(name: string): string {
  const short = name.replace(/^core\//, "");
  return BLOCK_WORDS[short] ?? short.replace(/-/g, " ");
}

function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/** "a gallery with 5 images", "3 blocks", "a heading and a paragraph". */
function describeBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "content";
  const records = blocks
    .map((block) => recordValue(block))
    .filter((block): block is Record<string, unknown> => block !== null);
  if (records.length === 1) {
    const only = records[0]!;
    const word = blockWord(String(only.name ?? "block"));
    const children = Array.isArray(only.children) ? only.children : [];
    const childNames = new Set(
      children.map((child) => String(recordValue(child)?.name ?? ""))
    );
    if (children.length > 0 && childNames.size === 1) {
      const childWord = blockWord([...childNames][0]!);
      return `${withArticle(word)} with ${children.length} ${childWord}${children.length === 1 ? "" : "s"}`;
    }
    return withArticle(word);
  }
  if (records.length === 2) {
    return records
      .map((block) => withArticle(blockWord(String(block.name ?? "block"))))
      .join(" and ");
  }
  return `${records.length} blocks`;
}

/** Human-readable scoped operations from an apply_operations plan. */
function planOperations(side: unknown): ChangeSummary[] {
  const plan = recordValue(recordValue(side)?.plan);
  if (!plan || !Array.isArray(plan.operations)) {
    return [];
  }
  return plan.operations.flatMap((operation): ChangeSummary[] => {
    const item = recordValue(operation);
    if (!item) {
      return [];
    }
    if (item.type === "insert_blocks") {
      const blocks = blockOutline(item.blocks);
      const parent = recordValue(item.parent);
      const position = typeof item.index === "number" ? item.index + 1 : "?";
      const where =
        Array.isArray(parent?.path) && parent.path.length > 0
          ? ` inside the block at ${blockPathLabel(parent.path)}`
          : "";
      return [
        {
          kind: "insert",
          label: `Added ${describeBlocks(item.blocks)} at position ${position}${where}`,
          blocks
        }
      ];
    }
    if (item.type === "edit_block") {
      return [
        {
          kind: "edit",
          label: `Changed the ${blockWord(String(recordValue(item.replacement)?.name ?? "block"))} at ${blockPathLabel(recordValue(item.target)?.path)}`,
          blocks: blockOutline([item.replacement])
        }
      ];
    }
    if (item.type === "remove_block") {
      return [
        {
          kind: "remove",
          label: `Removed the block at ${blockPathLabel(recordValue(item.target)?.path)}`,
          blocks: []
        }
      ];
    }
    if (item.type === "move_block") {
      const parent = recordValue(item.parent);
      const where =
        Array.isArray(parent?.path) && parent.path.length > 0
          ? ` inside the block at ${blockPathLabel(parent.path)}`
          : "";
      const position = typeof item.index === "number" ? item.index + 1 : "?";
      return [
        {
          kind: "move",
          label: `Moved the block at ${blockPathLabel(recordValue(item.target)?.path)} to position ${position}${where}`,
          blocks: []
        }
      ];
    }
    return [];
  });
}

/** Source blocks the plan deletes on purpose (removedSourceBlocks). */
function planRemovals(side: unknown): ChangeSummary[] {
  const plan = recordValue(recordValue(side)?.plan);
  if (!plan || !Array.isArray(plan.removedSourceBlocks)) {
    return [];
  }
  return plan.removedSourceBlocks.map((entry) => ({
    kind: "remove" as const,
    label: `Removed the block at ${blockPathLabel(recordValue(entry)?.path)}`,
    blocks: []
  }));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Blocks as a tidy list: a small type tag, then the block's text. */
function BlockList({ entries }: { entries: OutlineEntry[] }): ReactElement {
  return (
    <ul className="review-blocks">
      {entries.map((entry, index) => (
        <li
          key={`${index}-${entry.name}`}
          className={entry.depth > 0 ? "is-nested" : undefined}
          style={entry.depth > 1 ? { paddingLeft: `${(entry.depth - 1) * 1}rem` } : undefined}
        >
          <span className="review-block-type">{entry.name.replace(/-/g, " ")}</span>
          <span className="review-block-text">
            {entry.text
              ? entry.text.length > 90
                ? `${entry.text.slice(0, 90)}…`
                : entry.text
              : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StructureDiff({
  artifact
}: {
  artifact: ReviewArtifact;
}): ReactElement {
  const [value, setValue] = useState<unknown>(null);

  useEffect(() => {
    try {
      setValue(parseStructureArtifact(artifact));
    } catch {
      setValue("The structure comparison could not be displayed.");
    }
  }, [artifact]);

  const record = recordValue(value);
  const before = record?.before ?? record?.source ?? null;
  const after = record?.after ?? record?.candidate ?? null;
  const afterOutline = blockOutline(planBlocks(after));
  const beforeOutline = sourceIndexOutline(before);
  const operations = planOperations(after);
  const removals = planRemovals(after);
  const afterPlan = recordValue(recordValue(after)?.plan);
  const fieldsOnly =
    Array.isArray(afterPlan?.operations) && afterPlan.operations.length === 0;

  return (
    <div className="review-structure" aria-label="Structure comparison">
      {fieldsOnly ? (
        <p className="muted small-print">
          No content changes. Only the post fields below change.
        </p>
      ) : operations.length > 0 || removals.length > 0 ? (
        <ol className="review-change-list">
          {operations.map((operation, index) => (
            <ChangeRow key={`op-${index}`} change={operation} />
          ))}
          {removals.map((removal, index) => (
            <ChangeRow
              key={`rm-${index}`}
              change={{ ...removal, label: `${removal.label}, on purpose` }}
            />
          ))}
        </ol>
      ) : (
        <>
          <p className="review-structure-lead">
            {beforeOutline.length > 0 ? "Proposed content" : "New content"} ·{" "}
            {plural(afterOutline.length, "block")}
          </p>
          {afterOutline.length > 0 ? (
            <BlockList entries={afterOutline} />
          ) : (
            <p className="muted small-print">No block outline was supplied.</p>
          )}
        </>
      )}
      {beforeOutline.length > 0 ? (
        <details className="review-disclosure">
          <summary>Current content · {plural(beforeOutline.length, "block")}</summary>
          <BlockList entries={beforeOutline} />
        </details>
      ) : null}
      <details className="review-raw">
        <summary>Show raw structure data</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

function PreviewLightbox({
  source,
  label,
  onClose
}: {
  source: string;
  label: string;
  onClose: () => void;
}): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="gutenberg-v2-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div
        className="gutenberg-v2-lightbox-body"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gutenberg-v2-lightbox-header">
          <strong>{label}</strong>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <img src={source} alt={label} />
      </div>
    </div>
  );
}

function indexingLabel(value: string): string {
  return value === "noindex"
    ? "hidden from search engines (noindex)"
    : value === "index"
      ? "shown to search engines (index)"
      : "site default";
}

export function GutenbergV2CandidatePanel({
  candidate,
  busy,
  onDecide,
  onExecute,
  onLoadArtifact,
  approvalExpiresAt,
  siteUrl,
  top,
  children
}: Props): ReactElement {
  const [enlarged, setEnlarged] = useState<{
    source: string;
    label: string;
  } | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, ReviewArtifact>>(
    {}
  );
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactLoadAttempt, setArtifactLoadAttempt] = useState(0);
  // Rejecting records a required reason so admins (and Slack) see why.
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [previewLoadStatus, setPreviewLoadStatus] = useState<
    Record<string, "loaded" | "failed">
  >({});

  const reviewArtifacts = candidate.candidate?.reviewArtifacts ?? [];
  const artifactIds = reviewArtifacts.map(({ id }) => id).join("\u0000");
  const isAwaitingDecision = candidate.state === "review_ready";
  const canExecute =
    candidate.state === "approved" ||
    candidate.state === "preparing" ||
    candidate.state === "committing" ||
    candidate.state === "verifying";

  useEffect(() => {
    let active = true;
    setArtifacts({});
    setArtifactError(null);
    setPreviewLoadStatus({});

    void Promise.allSettled(
      reviewArtifacts.map(async ({ id }) => onLoadArtifact(id))
    ).then((loaded) => {
      if (!active) {
        return;
      }
      const next: Record<string, ReviewArtifact> = {};
      let failed = false;
      loaded.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          next[result.value.id] = result.value;
        } else {
          failed = true;
        }
      });
      setArtifacts(next);
      if (failed || Object.keys(next).length !== reviewArtifacts.length) {
        setArtifactError(
          "One or more review files could not be loaded. Refresh before deciding."
        );
      }
    });

    return () => {
      active = false;
    };
  }, [
    artifactIds,
    artifactLoadAttempt,
    candidate.candidate?.candidateId,
    onLoadArtifact
  ]);

  const previews = reviewArtifacts.flatMap((reference) => {
    const artifact = artifacts[reference.id];
    return artifact?.kind === "preview" ? [{ artifact, reference }] : [];
  });
  const structureReference = reviewArtifacts.find(
    ({ kind }) => kind === "structure_diff"
  );
  const structureDiff = structureReference
    ? artifacts[structureReference.id]
    : undefined;
  const hasInvalidArtifact = reviewArtifacts.some((reference) => {
    const artifact = artifacts[reference.id];
    if (!artifact || artifact.kind !== reference.kind) {
      return true;
    }
    if (artifact.kind === "preview") {
      return (
        safePreviewSource(artifact) === null ||
        previewLoadStatus[artifact.id] === "failed"
      );
    }
    try {
      parseStructureArtifact(artifact);
      return false;
    } catch {
      return true;
    }
  });
  const artifactsLoaded =
    Object.keys(artifacts).length === reviewArtifacts.length;
  const artifactFailure =
    artifactError ??
    (artifactsLoaded && hasInvalidArtifact
      ? "A review file could not be displayed. Refresh before deciding."
      : null);
  // A publish or unpublish renders nothing new, so there are no previews to
  // wait for; the approval card in the thread says where the post goes live.
  const statusChange = candidate.target.operation === "set_status";
  const reviewReady =
    statusChange ||
    (reviewArtifacts.length > 0 &&
      artifactsLoaded &&
      artifactError === null &&
      !hasInvalidArtifact &&
      previews.every(
        ({ artifact }) => previewLoadStatus[artifact.id] === "loaded"
      ));

  const status = v2StateStatus(candidate.state, {
    ...(approvalExpiresAt ? { approvalExpiresAt } : {}),
    publishing: statusChange
  });
  const fields = candidate.candidate?.requestedPostFields;
  const seoChanges = candidate.candidate?.seoChanges ?? [];
  const termChanges = candidate.candidate?.termChanges ?? [];
  const hasFieldChanges =
    Boolean(fields?.title) ||
    Boolean(fields?.excerpt) ||
    Boolean(candidate.candidate?.featuredImage) ||
    seoChanges.length > 0 ||
    termChanges.length > 0;
  const validationValid = candidate.candidate?.validation.outcome === "valid";
  const shownPreview =
    previews.find(({ reference }) => (reference.viewport ?? "desktop") === viewport) ??
    previews[0];
  const hasMobile = previews.some(({ reference }) => reference.viewport === "mobile");
  const expiresIn = approvalExpiresAt ? minutesUntil(approvalExpiresAt) : null;

  return (
    <section className="review-panel" aria-live="polite" aria-label="Review">
      <header className="review-header">
        <div className="review-header-copy">
          <h3>Review</h3>
          <p>
            {operationLabel(candidate.target)} · built{" "}
            {formatWhen(candidate.updatedAt)}
          </p>
        </div>
        <span
          className={`status-pill tone-${status.tone}`}
          role="status"
          aria-label="Candidate status"
        >
          {stateLabel(candidate.state)}
        </span>
      </header>

      <div className="review-body">
        {top}
        {candidate.failure ? (
          <p className="review-alert is-danger">{candidate.failure.message}</p>
        ) : null}
        {terminalFailureGuidance(candidate.state) ? (
          <p className="review-alert">{terminalFailureGuidance(candidate.state)}</p>
        ) : null}
        {candidate.candidate && !validationValid ? (
          <div className="review-alert is-danger">
            <strong>Checks need attention</strong>
            <ul>
              {candidate.candidate.validation.issues.map((issue) => (
                <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {statusChange && candidate.target.operation === "set_status" ? (
          <p className="review-alert is-info">
            {candidate.target.status === "publish"
              ? "Applying this publishes the post. Only its status changes; the content stays exactly as stored. SitePilot then checks the post loads for visitors."
              : "Applying this takes the post back to a draft, so visitors can no longer see it. The content stays exactly as stored."}
          </p>
        ) : null}
        {artifactFailure ? (
          <div className="review-alert is-danger">
            <span>{artifactFailure}</span>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={busy}
              onClick={() => setArtifactLoadAttempt((attempt) => attempt + 1)}
            >
              Retry loading review
            </button>
          </div>
        ) : null}

        {previews.length > 0 ? (
          <section className="review-section">
            <div className="review-section-head">
              <h4>Preview</h4>
              {hasMobile ? (
                <div className="segmented is-small" role="group" aria-label="Preview size">
                  <button
                    type="button"
                    aria-pressed={viewport === "desktop"}
                    onClick={() => setViewport("desktop")}
                  >
                    Desktop
                  </button>
                  <button
                    type="button"
                    aria-pressed={viewport === "mobile"}
                    onClick={() => setViewport("mobile")}
                  >
                    Mobile
                  </button>
                </div>
              ) : null}
            </div>
            {previews.map(({ artifact: preview, reference }) => {
              const source = safePreviewSource(preview);
              const label =
                reference.viewport === "mobile" ? "Mobile preview" : "Desktop preview";
              // Every preview stays mounted so it loads before approval is allowed.
              return source ? (
                <figure
                  key={preview.id}
                  className={`review-preview is-${reference.viewport ?? "desktop"}`}
                  hidden={shownPreview?.artifact.id !== preview.id}
                >
                  <div className="review-preview-bar" aria-hidden="true">
                    <span className="review-preview-dots" />
                    <span>
                      {siteUrl?.replace(/^https?:\/\//, "").replace(/\/+$/, "") ?? "Your site"}
                      {candidate.target.operation === "create_draft"
                        ? " · new draft"
                        : ` · ${candidate.target.postType} #${candidate.target.postId}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="review-preview-open"
                    title="Open full size"
                    onClick={() => setEnlarged({ source, label })}
                  >
                    <img
                      src={source}
                      alt={`${label} of candidate content`}
                      onLoad={() =>
                        setPreviewLoadStatus((current) => ({
                          ...current,
                          [preview.id]: "loaded"
                        }))
                      }
                      onError={() =>
                        setPreviewLoadStatus((current) => ({
                          ...current,
                          [preview.id]: "failed"
                        }))
                      }
                    />
                  </button>
                  <figcaption>
                    {label} from this site’s WordPress editor. Click to enlarge.
                  </figcaption>
                </figure>
              ) : null;
            })}
          </section>
        ) : null}

        {structureDiff ? (
          <section className="review-section">
            <div className="review-section-head">
              <h4>Changes to the content</h4>
            </div>
            <StructureDiff artifact={structureDiff} />
          </section>
        ) : null}

        {hasFieldChanges ? (
          <section className="review-section">
            <div className="review-section-head">
              <h4>Fields and SEO</h4>
            </div>
            <dl className="review-fields">
              {fields?.title ? (
                <div>
                  <dt>Title</dt>
                  <dd>{fields.title}</dd>
                </div>
              ) : null}
              {candidate.candidate?.featuredImage ? (
                <div>
                  <dt>Featured image</dt>
                  <dd>{candidate.candidate.featuredImage.label}</dd>
                </div>
              ) : null}
              {fields?.excerpt ? (
                <div>
                  <dt>Excerpt</dt>
                  <dd>{fields.excerpt}</dd>
                </div>
              ) : null}
              {termChanges.map((change) => (
                <div key={change.taxonomy}>
                  <dt>{change.label}</dt>
                  <dd>{change.value}</dd>
                </div>
              ))}
              {seoChanges.map((change) => (
                <div key={change.field}>
                  <dt>{change.label}</dt>
                  <dd>
                    {change.value === ""
                      ? "Cleared (plugin default)"
                      : change.field === "indexing"
                        ? indexingLabel(change.value)
                        : change.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {candidate.result ? (
          <section className="review-section">
            <div className="review-section-head">
              <h4>Result</h4>
            </div>
            <p className="review-result">
              {candidate.result.verification?.outcome === "valid"
                ? "✓ Saved and verified against the site."
                : "Saved, but not verified yet."}
              {candidate.result.postId ? ` Post #${candidate.result.postId}.` : ""}
            </p>
            {siteUrl && candidate.result.postId ? (
              <a
                className="btn btn-secondary btn-small review-result-link"
                href={`${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${candidate.result.postId}&action=edit`}
                target="_blank"
                rel="noreferrer"
              >
                Open in the WordPress editor ↗
              </a>
            ) : null}
          </section>
        ) : null}
        {children}
      </div>

      {isAwaitingDecision && candidate.candidate ? (
        <footer className="review-footer">
          <p className={`review-checks${validationValid && reviewReady ? " is-ok" : ""}`}>
            {!validationValid
              ? "Some checks need attention before this can be approved."
              : reviewReady
                ? "✓ All checks passed. Nothing else on the page changes."
                : "Loading the review files…"}
          </p>
          {rejecting ? (
            <div className="review-reject">
              <label className="settings-field">
                <span>Reason for rejecting</span>
                <textarea
                  rows={3}
                  value={rejectReason}
                  disabled={busy}
                  maxLength={4_000}
                  placeholder="What is wrong with this update? This is recorded in the thread and audit log."
                  onChange={(event) => setRejectReason(event.target.value)}
                />
              </label>
              <div className="review-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setRejecting(false);
                    setRejectReason("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger review-actions-main"
                  disabled={busy || rejectReason.trim().length === 0}
                  onClick={() =>
                    void onDecide(
                      candidate.candidate!.candidateId,
                      "rejected",
                      rejectReason.trim()
                    ).then(() => {
                      setRejecting(false);
                      setRejectReason("");
                    })
                  }
                >
                  Confirm rejection
                </button>
              </div>
            </div>
          ) : (
            <div className="review-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !reviewReady}
                onClick={() => setRejecting(true)}
              >
                Reject…
              </button>
              <button
                type="button"
                className="btn btn-primary review-actions-main"
                disabled={busy || !reviewReady || !validationValid}
                onClick={() =>
                  void onDecide(candidate.candidate!.candidateId, "approved")
                }
              >
                Approve this update
              </button>
            </div>
          )}
          <p className="review-small">
            Approving doesn’t change the site. You apply it as a separate step,
            within 30 minutes. To change the update instead, reply in the thread.
          </p>
        </footer>
      ) : null}

      {canExecute ? (
        <footer className="review-footer">
          <p className="review-checks is-ok">
            {candidate.state === "approved"
              ? "✓ Approved. Nothing on the site changes until you apply it."
              : "The last apply didn’t finish. Continuing is safe."}
          </p>
          <div className="review-actions">
            <button
              type="button"
              className="btn btn-primary review-actions-main"
              disabled={busy || (expiresIn !== null && expiresIn <= 0)}
              onClick={() => void onExecute()}
            >
              {candidate.state === "approved"
                ? "Apply this update to the site"
                : "Continue applying"}
            </button>
          </div>
          {candidate.state === "approved" && expiresIn !== null ? (
            <p className="review-small">
              {expiresIn > 0
                ? `Approval valid for ${expiresIn} more min. If the page is edited in WordPress first, SitePilot stops and asks again.`
                : "This approval has expired. Reply in the thread to rebuild it."}
            </p>
          ) : null}
        </footer>
      ) : null}

      {enlarged ? (
        <PreviewLightbox
          source={enlarged.source}
          label={enlarged.label}
          onClose={() => setEnlarged(null)}
        />
      ) : null}
    </section>
  );
}
