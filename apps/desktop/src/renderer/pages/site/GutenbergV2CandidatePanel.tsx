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

function structureLabel(value: unknown): string {
  const record = recordValue(value);
  if (!record) {
    return "No structure details were supplied.";
  }
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.length
    : undefined;
  const summary =
    typeof record.summary === "string" ? record.summary : undefined;
  return (
    summary ??
    (blocks === undefined ? "Compiled structure" : `${blocks} blocks`)
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

  return (
    <div
      className="gutenberg-v2-structure-diff"
      aria-label="Structure comparison"
    >
      <div className="gutenberg-v2-structure-summary">
        <section>
          <h6>Before</h6>
          <p>{structureLabel(before)}</p>
        </section>
        <section>
          <h6>After</h6>
          <p>{structureLabel(after)}</p>
        </section>
      </div>
      <details>
        <summary>View the full structure comparison</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
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
  const [artifacts, setArtifacts] = useState<Record<string, ReviewArtifact>>(
    {}
  );
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [artifactLoadAttempt, setArtifactLoadAttempt] = useState(0);
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
    setDecisionNote("");
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
            Compare the compiled structure and responsive previews. Approval is
            tied to this exact candidate.
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
                return source ? (
                  <figure key={preview.id} className="gutenberg-v2-preview">
                    <img
                      src={source}
                      alt={`${reference.viewport === "mobile" ? "Mobile" : "Desktop"} preview of candidate content`}
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
                    <figcaption className="small-print">
                      {reference.viewport === "mobile"
                        ? "Mobile preview"
                        : "Desktop preview"}
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
          <label className="settings-field">
            <span>Revision note (optional)</span>
            <textarea
              rows={2}
              value={decisionNote}
              disabled={busy}
              placeholder="Describe the adjustment you need…"
              onChange={(event) => setDecisionNote(event.target.value)}
            />
          </label>
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
              Approve candidate
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !reviewReady}
              onClick={() =>
                void onDecide(
                  candidate.candidate!.candidateId,
                  "revision_requested",
                  decisionNote.trim() || undefined
                )
              }
            >
              Request revision
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !reviewReady}
              onClick={() =>
                void onDecide(candidate.candidate!.candidateId, "rejected")
              }
            >
              Reject
            </button>
          </div>
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
              ? "Execute approved candidate"
              : "Continue execution"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
