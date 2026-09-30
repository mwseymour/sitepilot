import type { ReactElement } from "react";

import { formatAttachmentCount } from "./attachments.js";
import type { RequestBundleOk } from "./types.js";

type DeveloperPanelProps = {
  bundle: RequestBundleOk | null;
  busy: boolean;
  debugCopyLabel: string;
  developerMessages: string[];
  pendingAttachmentCount: number;
  pendingAttachmentBytes: number;
  onCopyDebugLog: () => void;
};

export function DeveloperPanel({
  bundle,
  busy,
  debugCopyLabel,
  developerMessages,
  pendingAttachmentCount,
  pendingAttachmentBytes,
  onCopyDebugLog
}: DeveloperPanelProps): ReactElement {
  return (
    <details className="chat-debug-panel">
      <summary>Developer tools</summary>
      <div className="chat-debug-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={onCopyDebugLog}
        >
          {debugCopyLabel}
        </button>
        <span className="muted small-print">
          Copies chat history and request state as JSON.
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
    </details>
  );
}
