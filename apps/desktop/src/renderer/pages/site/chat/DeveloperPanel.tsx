import type { ReactElement } from "react";

import { actionToMcpToolCall } from "@sitepilot/services/mcp-action-map";

import { formatAttachmentCount } from "./attachments.js";
import {
  actionCanResolveViaLookup,
  actionCanResolveViaPlannedCreate,
  actionUnavailableReason,
  requestCanExecute
} from "./plan-actions.js";
import { SHOW_DRY_RUN_UI, type RequestBundleOk } from "./types.js";

type PlanAction = NonNullable<
  RequestBundleOk["plan"]
>["proposedActions"][number];

function PlannedActionRow({
  action,
  planIndex,
  planActions,
  requestStatus,
  busy,
  execBusy,
  executionControlsLocked,
  onExecuteAction
}: {
  action: PlanAction;
  planIndex: number;
  planActions: PlanAction[];
  requestStatus: string;
  busy: boolean;
  execBusy: boolean;
  executionControlsLocked: boolean;
  onExecuteAction: (actionId: string, dryRun: boolean) => void;
}): ReactElement {
  const actionIndex = planActions.findIndex(
    (candidate) => candidate.id === action.id
  );
  const priorActions = actionIndex > 0 ? planActions.slice(0, actionIndex) : [];
  const spec = actionToMcpToolCall(action.type, action.input, true);
  const remote =
    spec !== null ||
    actionCanResolveViaLookup(action.type, action.input) ||
    actionCanResolveViaPlannedCreate(action.type, action.input, priorActions);

  return (
    <li className="chat-action-row">
      <div className="chat-action-main">
        <div className="chat-action-step">Step {planIndex + 1}</div>
        <div className="chat-action-copy">
          <strong>{action.type}</strong>
          {remote ? (
            <span className="muted small-print">
              {spec?.toolName ??
                (actionCanResolveViaLookup(action.type, action.input)
                  ? "target via lookup"
                  : "target via planned create")}
            </span>
          ) : (
            <span className="muted small-print">
              {actionUnavailableReason(action.type, action.input)}
            </span>
          )}
        </div>
      </div>
      <div className="chat-action-buttons">
        {remote ? (
          <>
            {SHOW_DRY_RUN_UI && !executionControlsLocked ? (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={execBusy || busy}
                onClick={() => onExecuteAction(action.id, true)}
              >
                Dry-run
              </button>
            ) : null}
            {!executionControlsLocked ? (
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={execBusy || busy || !requestCanExecute(requestStatus)}
                onClick={() => onExecuteAction(action.id, false)}
              >
                Execute
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

type DeveloperPanelProps = {
  bundle: RequestBundleOk | null;
  busy: boolean;
  execBusy: boolean;
  executionControlsLocked: boolean;
  debugCopyLabel: string;
  developerMessages: string[];
  pendingAttachmentCount: number;
  pendingAttachmentBytes: number;
  planValidationJson: string | null;
  plannerJson: string | null;
  onCopyDebugLog: () => void;
  onExecuteAction: (actionId: string, dryRun: boolean) => void;
  onBuildPlannerContext: () => void;
};

export function DeveloperPanel({
  bundle,
  busy,
  execBusy,
  executionControlsLocked,
  debugCopyLabel,
  developerMessages,
  pendingAttachmentCount,
  pendingAttachmentBytes,
  planValidationJson,
  plannerJson,
  onCopyDebugLog,
  onExecuteAction,
  onBuildPlannerContext
}: DeveloperPanelProps): ReactElement {
  return (
    <details className="chat-debug-panel">
      <summary>Developer tools</summary>
      <div className="chat-debug-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy || execBusy}
          onClick={onCopyDebugLog}
        >
          {debugCopyLabel}
        </button>
        <span className="muted small-print">
          Copies chat history, request state, plan data, and last execution
          details as JSON.
        </span>
      </div>
      {developerMessages.length > 0 ? (
        <div className="chat-planner-panel">
          <h3>Feedback log</h3>
          <ul className="small-print">
            {developerMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {bundle?.plan ? (
        <div className="chat-bundle-panel">
          <h4>Planned actions</h4>
          <ul className="chat-action-list">
            {bundle.plan.proposedActions.map((action, planIndex) => (
              <PlannedActionRow
                key={action.id}
                action={action}
                planIndex={planIndex}
                planActions={bundle.plan?.proposedActions ?? []}
                requestStatus={bundle.request.status}
                busy={busy}
                execBusy={execBusy}
                executionControlsLocked={executionControlsLocked}
                onExecuteAction={onExecuteAction}
              />
            ))}
          </ul>
          {executionControlsLocked ? (
            <p className="muted small-print">
              This plan has already run. Generate a new action plan to enable
              execution again.
            </p>
          ) : !requestCanExecute(bundle.request.status) ? (
            <p className="muted small-print">
              Execute stays disabled until the request is ready to run.
            </p>
          ) : null}
        </div>
      ) : null}
      {bundle ? (
        <div className="chat-planner-panel">
          <h3>Current request prompt</h3>
          <pre className="diag-json">{bundle.request.userPrompt}</pre>
        </div>
      ) : null}
      {pendingAttachmentCount > 0 ? (
        <div className="chat-planner-panel">
          <h3>Pending image context</h3>
          <p className="small-print">
            {formatAttachmentCount(pendingAttachmentCount)} ·{" "}
            {Math.round(pendingAttachmentBytes / 1024)} KB after compression ·
            planner limit 3 images
          </p>
        </div>
      ) : null}
      {planValidationJson ? (
        <div className="chat-planner-panel">
          <h3>Plan validation</h3>
          <pre className="diag-json">{planValidationJson}</pre>
        </div>
      ) : null}
      {bundle?.plan ? (
        <div className="chat-planner-panel">
          <h3>Planned action input</h3>
          <pre className="diag-json">
            {JSON.stringify(bundle.plan.proposedActions, null, 2)}
          </pre>
        </div>
      ) : null}
      {bundle?.lastExecution?.toolInvocation ? (
        <div className="chat-planner-panel">
          <h3>Last MCP request</h3>
          <p className="muted small-print">
            Tool: {bundle.lastExecution.toolInvocation.toolName}
          </p>
          <pre className="diag-json">
            {JSON.stringify(bundle.lastExecution.toolInvocation.input, null, 2)}
          </pre>
        </div>
      ) : null}
      {bundle?.lastExecution?.toolInvocation?.output ? (
        <div className="chat-planner-panel">
          <h3>Last MCP response</h3>
          <pre className="diag-json">
            {JSON.stringify(
              bundle.lastExecution.toolInvocation.output,
              null,
              2
            )}
          </pre>
        </div>
      ) : null}
      <div className="chat-planner-panel">
        <h3>Planner context</h3>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={onBuildPlannerContext}
        >
          Build planner context
        </button>
        {plannerJson ? <pre className="diag-json">{plannerJson}</pre> : null}
      </div>
    </details>
  );
}
