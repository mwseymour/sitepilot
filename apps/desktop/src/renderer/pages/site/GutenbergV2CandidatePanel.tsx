import { useEffect, useState, type ReactElement } from "react";

import type { ipcChannels, IpcResponse } from "@sitepilot/contracts";

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

  const label =
    target.operation === "replace_content"
      ? "Replace all content"
      : "Apply selected changes";
  return `${label} on ${target.postType} #${target.postId ?? "unknown"}`;
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    review_ready: "Ready for review",
    approved: "Approved",
    preparing: "Preparing the update",
    committing: "Saving the update",
    verifying: "Verifying the saved content",
    succeeded: "Completed and verified",
    rejected: "Rejected",
    pre_write_failed: "Could not save the update",
    post_write_verification_failed: "Verification needs attention",
    rolled_back: "Rolled back safely",
    rollback_conflict: "Rollback needs attention",
    manual_intervention_required: "Needs attention"
  };
  return labels[state] ?? state.replaceAll("_", " ");
}

function terminalFailureGuidance(state: string): string | null {
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
  "mediaAlt"
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
    return [
      {
        depth: Math.max(0, item.path.length - 1),
        name: item.name.replace(/^core\//, ""),
        text: blockPathLabel(item.path)
      }
    ];
  });
}

type ChangeSummary = { label: string; blocks: OutlineEntry[] };

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
      const count = Array.isArray(item.blocks) ? item.blocks.length : 0;
      return [
        {
          label: `Insert ${count} ${count === 1 ? "block" : "blocks"} at position ${position}${where}`,
          blocks
        }
      ];
    }
    if (item.type === "edit_block") {
      return [
        {
          label: `Replace the block at ${blockPathLabel(recordValue(item.target)?.path)}`,
          blocks: blockOutline([item.replacement])
        }
      ];
    }
    if (item.type === "remove_block") {
      return [
        {
          label: `Remove the block at ${blockPathLabel(recordValue(item.target)?.path)}`,
          blocks: []
        }
      ];
    }
    return [];
  });
}

function Outline({ entries }: { entries: OutlineEntry[] }): ReactElement {
  return (
    <ol className="gutenberg-v2-outline">
      {entries.map((entry, index) => (
        <li
          key={`${index}-${entry.name}`}
          style={{ paddingLeft: `${entry.depth * 1.1}rem` }}
        >
          <span className="gutenberg-v2-outline-name">{entry.name}</span>
          {entry.text ? (
            <span className="gutenberg-v2-outline-text">
              {entry.text.length > 90
                ? `${entry.text.slice(0, 90)}…`
                : entry.text}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
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
  const afterPlan = recordValue(recordValue(after)?.plan);
  const fieldsOnly =
    Array.isArray(afterPlan?.operations) && afterPlan.operations.length === 0;

  return (
    <div
      className="gutenberg-v2-structure-diff"
      aria-label="Structure comparison"
    >
      {beforeOutline.length > 0 ? (
        <details>
          <summary>Current content ({beforeOutline.length} blocks)</summary>
          <Outline entries={beforeOutline} />
        </details>
      ) : null}
      {fieldsOnly ? (
        <p className="muted small-print">
          No content changes. Only the post settings shown above change.
        </p>
      ) : operations.length > 0 ? (
        <>
          <h6>
            Changes ({operations.length}{" "}
            {operations.length === 1 ? "change" : "changes"})
          </h6>
          <ol className="gutenberg-v2-changes">
            {operations.map((operation, index) => (
              <li key={`${index}-${operation.label}`}>
                <p className="gutenberg-v2-change-label">{operation.label}</p>
                {operation.blocks.length > 0 ? (
                  <Outline entries={operation.blocks} />
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <h6>
            {beforeOutline.length > 0 ? "Proposed content" : "New content"} (
            {afterOutline.length} blocks)
          </h6>
          {afterOutline.length > 0 ? (
            <Outline entries={afterOutline} />
          ) : (
            <p className="muted small-print">No block outline was supplied.</p>
          )}
        </>
      )}
      <details>
        <summary>Raw structure data</summary>
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

export function GutenbergV2CandidatePanel({
  candidate,
  busy,
  onDecide,
  onExecute,
  onLoadArtifact
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
  const reviewReady =
    reviewArtifacts.length > 0 &&
    artifactsLoaded &&
    artifactError === null &&
    !hasInvalidArtifact &&
    previews.every(
      ({ artifact }) => previewLoadStatus[artifact.id] === "loaded"
    );

  return (
    <section className="gutenberg-v2-candidate-panel" aria-live="polite">
      <header className="gutenberg-v2-candidate-header">
        <div>
          <p className="eyebrow">Native editor candidate</p>
          <h4>{operationLabel(candidate.target)}</h4>
          <p className="muted small-print">
            Status:{" "}
            <span className="badge" role="status" aria-label="Candidate status">
              {stateLabel(candidate.state)}
            </span>
          </p>
        </div>
      </header>

      {candidate.candidate?.requestedPostFields.title ? (
        <p className="gutenberg-v2-title">
          <strong>Title:</strong>{" "}
          {candidate.candidate.requestedPostFields.title}
        </p>
      ) : null}
      {candidate.candidate?.featuredImage ? (
        <p className="muted small-print">
          <strong>Featured image:</strong>{" "}
          {candidate.candidate.featuredImage.label}
        </p>
      ) : null}
      {candidate.candidate?.requestedPostFields.excerpt ? (
        <p className="muted small-print">
          <strong>Excerpt:</strong>{" "}
          {candidate.candidate.requestedPostFields.excerpt}
        </p>
      ) : null}
      {candidate.failure ? (
        <p className="workspace-error">{candidate.failure.message}</p>
      ) : null}
      {terminalFailureGuidance(candidate.state) ? (
        <p className="muted small-print">
          {terminalFailureGuidance(candidate.state)}
        </p>
      ) : null}
      {candidate.candidate &&
      candidate.candidate.validation.outcome !== "valid" ? (
        <div className="gutenberg-v2-validation">
          <h5>Candidate checks need attention</h5>
          <ul className="small-print">
            {candidate.candidate.validation.issues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {reviewArtifacts.length > 0 ? (
        <div className="gutenberg-v2-review">
          <h5>Review before approval</h5>
          <p className="muted small-print">
            Compare the compiled structure and responsive previews from this
            connected WordPress site’s editor. Approval is required before
            anything is saved. To change the update, reply in the thread — you
            can attach images there.
          </p>
          {artifactFailure ? (
            <>
              <p className="workspace-error">{artifactFailure}</p>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={busy}
                onClick={() => setArtifactLoadAttempt((attempt) => attempt + 1)}
              >
                Retry loading review
              </button>
            </>
          ) : null}
          {structureDiff ? <StructureDiff artifact={structureDiff} /> : null}
          {previews.length > 0 ? (
            <div className="gutenberg-v2-preview-grid">
              {previews.map(({ artifact: preview, reference }) => {
                const source = safePreviewSource(preview);
                const label =
                  reference.viewport === "mobile"
                    ? "Mobile preview"
                    : "Desktop preview";
                return source ? (
                  <figure
                    key={preview.id}
                    className={`gutenberg-v2-preview gutenberg-v2-preview-${reference.viewport ?? "desktop"}`}
                  >
                    <button
                      type="button"
                      className="gutenberg-v2-preview-open"
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
                    <figcaption className="small-print">
                      {label} from this site’s WordPress editor. Click to
                      enlarge.
                    </figcaption>
                  </figure>
                ) : null;
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {candidate.result ? (
        <div className="gutenberg-v2-result">
          <h5>Execution result</h5>
          <p className="small-print">
            {candidate.result.verification?.outcome === "valid"
              ? "Verified against the destination."
              : "Execution is not yet verified."}
            {candidate.result.postId
              ? ` Post #${candidate.result.postId}.`
              : ""}
          </p>
        </div>
      ) : null}

      {isAwaitingDecision && candidate.candidate ? (
        <div className="gutenberg-v2-decision">
          <p className="muted small-print">
            Approve this update, or reply in the thread to change it. The thread
            accepts images and updates the same request.
          </p>
          <div className="action-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy ||
                !reviewReady ||
                candidate.candidate.validation.outcome !== "valid"
              }
              onClick={() =>
                void onDecide(candidate.candidate!.candidateId, "approved")
              }
            >
              Approve this update
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !reviewReady || rejecting}
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          </div>
          {rejecting ? (
            <div className="gutenberg-v2-reject">
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
              <div className="action-row">
                <button
                  type="button"
                  className="btn btn-primary"
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
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {canExecute ? (
        <div className="action-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onExecute()}
          >
            {candidate.state === "approved"
              ? "Apply this update to the site"
              : "Continue execution"}
          </button>
        </div>
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
