import type { ReactElement } from "react";

import {
  humanRequestStatus,
  type RequestNextAction,
  type RequestNextActionId
} from "../../../chat-workflow.js";
import { AttachmentGrid, formatAttachmentCount } from "./attachments.js";
import { ExpandableText } from "./ExpandableText.js";
import { buildDiffLines, extractBeforeAfter } from "./message-format.js";
import { requestCanExecute } from "./plan-actions.js";
import {
  REQUEST_PROMPT_PREVIEW_THRESHOLD,
  SHOW_DRY_RUN_UI,
  type DryRunPreview,
  type RequestBundleOk
} from "./types.js";

type NextActionCardProps = {
  nextAction: RequestNextAction;
  requestStatus: string;
  busy: boolean;
  execBusy: boolean;
  execProgressLabel: string | null;
  canGeneratePlanNow: boolean;
  executionControlsLocked: boolean;
  onNextAction: (id: RequestNextActionId) => void;
  onRejectPlan: () => void;
  onDryRunPlan: () => void;
};

// Legacy v1 next-step card; the v2 candidate panel replaces it for v2 requests.
function NextActionCard({
  nextAction,
  requestStatus,
  busy,
  execBusy,
  execProgressLabel,
  canGeneratePlanNow,
  executionControlsLocked,
  onNextAction,
  onRejectPlan,
  onDryRunPlan
}: NextActionCardProps): ReactElement {
  const primary = nextAction.primary;
  return (
    <div className="chat-next-action">
      <div className="chat-next-action-copy">
        <span className="badge">{nextAction.statusLabel}</span>
        <h4>{nextAction.title}</h4>
        <p className="muted small-print">{nextAction.helper}</p>
      </div>
      <div className="action-row chat-next-action-buttons">
        {primary ? (
          <button
            type="button"
            className={
              primary.id === "reply" ? "btn btn-secondary" : "btn btn-primary"
            }
            disabled={
              busy ||
              (primary.id === "generate_plan" && !canGeneratePlanNow) ||
              (primary.id === "run_plan" &&
                (!requestCanExecute(requestStatus) || execBusy))
            }
            onClick={() => onNextAction(primary.id)}
          >
            {primary.label}
          </button>
        ) : null}
        {primary?.id === "approve_plan" ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={onRejectPlan}
          >
            Reject plan
          </button>
        ) : null}
        {nextAction.secondary.map((action) => (
          <button
            key={action.id}
            type="button"
            className="btn btn-secondary"
            disabled={
              busy || (action.id === "generate_plan" && !canGeneratePlanNow)
            }
            onClick={() => onNextAction(action.id)}
          >
            {action.label}
          </button>
        ))}
        {primary?.id === "run_plan" &&
        SHOW_DRY_RUN_UI &&
        !executionControlsLocked ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={execBusy || busy}
            onClick={onDryRunPlan}
          >
            {execBusy && execProgressLabel === "Running dry-run…"
              ? "Running dry-run…"
              : "Dry-run plan"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type ReferenceAnalysisPanelProps = {
  visualAnalysis: RequestBundleOk["visualAnalysis"];
  visualAnalysisStale: boolean;
  busy: boolean;
  onAnalyze: () => void;
  onReview: () => void;
};

// Legacy v1 screenshot/mockup analysis gate.
function ReferenceAnalysisPanel({
  visualAnalysis,
  visualAnalysisStale,
  busy,
  onAnalyze,
  onReview
}: ReferenceAnalysisPanelProps): ReactElement {
  return (
    <div className="chat-bundle-panel">
      <h4>Reference analysis</h4>
      <p className="muted small-print">
        {visualAnalysis === null
          ? "This request looks like a screenshot/mockup build. Analyze the uploaded reference before planning."
          : visualAnalysisStale
            ? "The request changed after the last screenshot analysis. Re-run analysis, review it, then generate the plan."
            : visualAnalysis.reviewedAt === undefined
              ? "Review the generated screenshot manifest, then approve it for planning."
              : "Reviewed screenshot manifest is ready for planning."}
      </p>
      <p className="small-print">
        <span className="badge">
          {visualAnalysis === null
            ? "missing"
            : visualAnalysisStale
              ? "stale"
              : visualAnalysis.reviewedAt === undefined
                ? "generated"
                : "reviewed"}
        </span>
      </p>
      {visualAnalysis ? (
        <>
          <p className="small-print">
            <strong>{visualAnalysis.pageType}</strong> ·{" "}
            {visualAnalysis.layoutPattern}
          </p>
          <p className="small-print">{visualAnalysis.summary}</p>
          <div className="chat-planner-panel">
            <h5>Regions</h5>
            <ul className="chat-action-list">
              {visualAnalysis.regions.map((region) => (
                <li key={region.id} className="chat-action-row">
                  <div>
                    <strong>{region.label}</strong>
                    <div className="muted small-print">
                      {region.kind} · {region.layout} · {region.position} ·
                      confidence {Math.round(region.confidence * 100)}%
                    </div>
                    <div className="small-print">{region.contentSummary}</div>
                    <div className="muted small-print">
                      Blocks: {region.suggestedBlocks.join(", ")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {visualAnalysis.mappingWarnings.length > 0 ? (
            <div className="chat-planner-panel">
              <h5>Mapping warnings</h5>
              <ul className="small-print">
                {visualAnalysis.mappingWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="action-row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={onAnalyze}
        >
          {visualAnalysis === null || visualAnalysisStale
            ? "Analyze reference"
            : "Re-analyze reference"}
        </button>
        {visualAnalysis !== null && !visualAnalysisStale ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={onReview}
          >
            {visualAnalysis.reviewedAt === undefined
              ? "Approve analysis"
              : "Re-approve analysis"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PlanNextSteps({
  actionCount,
  openQuestions
}: {
  actionCount: number;
  openQuestions: string[];
}): ReactElement {
  return (
    <div className="chat-plan-next-steps">
      <div className="chat-plan-next-steps-meta" aria-label="Plan summary">
        <span className="badge">{actionCount} actions</span>
        {openQuestions.length > 0 ? (
          <span className="badge badge-warn">
            {openQuestions.length} open question
            {openQuestions.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="badge">Ready for review</span>
        )}
      </div>
      {openQuestions.length > 0 ? (
        <div className="chat-plan-next-steps-section">
          <h5>Questions to answer</h5>
          <ol className="chat-plan-question-list">
            {openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function DryRunPreviewPanel({
  preview,
  onClear
}: {
  preview: DryRunPreview;
  onClear: () => void;
}): ReactElement {
  const { before, after } = extractBeforeAfter(preview.mcpResult);
  const diffLines = buildDiffLines(before, after);

  return (
    <div className="chat-bundle-panel">
      <div className="chat-plan-runbar">
        <div>
          <h4>Dry-run Preview</h4>
          <p className="muted small-print">
            {preview.actionType}
            {preview.toolName ? ` → ${preview.toolName}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
      {preview.requestInput ? (
        <>
          <h5>Planned MCP request</h5>
          <pre className="diag-json">
            {JSON.stringify(preview.requestInput, null, 2)}
          </pre>
        </>
      ) : null}
      <h5>Diff</h5>
      <pre className="chat-diff-view" aria-label="Dry-run diff">
        {diffLines.map((line, index) => (
          <span
            key={`${line.kind}-${index}-${line.text}`}
            className={`chat-diff-line chat-diff-line-${line.kind}`}
          >
            {line.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

type RequestPanelProps = {
  bundle: RequestBundleOk;
  requestNextAction: RequestNextAction | null;
  isV2Workflow: boolean;
  busy: boolean;
  execBusy: boolean;
  execProgressLabel: string | null;
  canGeneratePlan: boolean;
  canGeneratePlanNow: boolean;
  executionControlsLocked: boolean;
  visualAnalysisRequired: boolean;
  visualAnalysisStale: boolean;
  openQuestions: string[];
  dryRunPreview: DryRunPreview | null;
  onNextAction: (id: RequestNextActionId) => void;
  onRejectPlan: () => void;
  onDryRunPlan: () => void;
  onAnalyzeReference: () => void;
  onReviewReference: () => void;
  onClearDryRun: () => void;
};

/**
 * Current request summary for the side column. The next-step card, status,
 * reference analysis, plan and dry-run sections are the legacy v1 workflow
 * and are hidden for v2 requests (the candidate panel owns those steps).
 */
export function RequestPanel({
  bundle,
  requestNextAction,
  isV2Workflow,
  busy,
  execBusy,
  execProgressLabel,
  canGeneratePlan,
  canGeneratePlanNow,
  executionControlsLocked,
  visualAnalysisRequired,
  visualAnalysisStale,
  openQuestions,
  dryRunPreview,
  onNextAction,
  onRejectPlan,
  onDryRunPlan,
  onAnalyzeReference,
  onReviewReference,
  onClearDryRun
}: RequestPanelProps): ReactElement {
  return (
    <div className="chat-request-panel">
      {requestNextAction && !isV2Workflow ? (
        <NextActionCard
          nextAction={requestNextAction}
          requestStatus={bundle.request.status}
          busy={busy}
          execBusy={execBusy}
          execProgressLabel={execProgressLabel}
          canGeneratePlanNow={canGeneratePlanNow}
          executionControlsLocked={executionControlsLocked}
          onNextAction={onNextAction}
          onRejectPlan={onRejectPlan}
          onDryRunPlan={onDryRunPlan}
        />
      ) : null}
      <h3>Current request</h3>
      <ExpandableText
        text={bundle.request.userPrompt}
        className="chat-request-current"
        collapsedClassName="chat-request-current-collapsed"
        previewThreshold={REQUEST_PROMPT_PREVIEW_THRESHOLD}
      />
      {bundle.request.attachments && bundle.request.attachments.length > 0 ? (
        <div className="chat-request-attachments">
          <p className="muted small-print">
            Attached {formatAttachmentCount(bundle.request.attachments.length)}
          </p>
          <AttachmentGrid
            attachments={bundle.request.attachments}
            keyFor={(attachment) =>
              `request-${attachment.fileName}-${attachment.sizeBytes}`
            }
          />
        </div>
      ) : null}
      {!isV2Workflow ? (
        <div className="chat-request-meta">
          <h4>Request status</h4>
          <p className="small-print">
            <span className="badge">
              {humanRequestStatus(bundle.request.status)}
            </span>
            {bundle.pendingApproval ? (
              <>
                {" "}
                <span className="badge badge-warn">Pending approval</span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {visualAnalysisRequired && !isV2Workflow ? (
        <ReferenceAnalysisPanel
          visualAnalysis={bundle.visualAnalysis}
          visualAnalysisStale={visualAnalysisStale}
          busy={busy}
          onAnalyze={onAnalyzeReference}
          onReview={onReviewReference}
        />
      ) : null}
      {canGeneratePlan && !canGeneratePlanNow && !isV2Workflow ? (
        <p className="muted small-print">
          Generate plan stays locked until the reference analysis is current and
          approved.
        </p>
      ) : null}
      {bundle.plan ? (
        <PlanNextSteps
          actionCount={bundle.plan.proposedActions.length}
          openQuestions={openQuestions}
        />
      ) : null}
      {bundle.lastExecution ? (
        <p className="muted small-print">
          Last run: <code>{bundle.lastExecution.status}</code> ·{" "}
          <code className="break-all">
            {bundle.lastExecution.idempotencyKey}
          </code>
        </p>
      ) : null}
      {dryRunPreview ? (
        <DryRunPreviewPanel preview={dryRunPreview} onClear={onClearDryRun} />
      ) : null}
      {!bundle.plan && !isV2Workflow ? (
        <p className="muted small-print">
          No plan yet. Keep refining the request, then generate a plan.
        </p>
      ) : null}
    </div>
  );
}
