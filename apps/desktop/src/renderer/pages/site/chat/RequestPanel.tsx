import type { ReactElement } from "react";

import { humanRequestStatus } from "../../../chat-workflow.js";
import { AttachmentGrid, formatAttachmentCount } from "./attachments.js";
import { ExpandableText } from "./ExpandableText.js";
import {
  REQUEST_PROMPT_PREVIEW_THRESHOLD,
  type RequestBundleOk
} from "./types.js";

/** Read-only note for a request made with the removed v1 engine. */
function LegacyV1Note({
  legacy,
  requestStatus
}: {
  legacy: NonNullable<RequestBundleOk["legacyV1"]>;
  requestStatus: string;
}): ReactElement {
  const changes =
    legacy.plannedActionCount === 1
      ? "1 planned change"
      : `${legacy.plannedActionCount} planned changes`;
  return (
    <div className="chat-next-action">
      <div className="chat-next-action-copy">
        <span className="badge">{humanRequestStatus(requestStatus)}</span>
        <h4>Made with the old engine</h4>
        <p className="muted small-print">
          This request had {changes}
          {legacy.lastRunStatus
            ? `, and its last run ${legacy.lastRunStatus}`
            : ""}
          . SitePilot no longer runs the engine it was made with. Start a new
          request to make this change.
        </p>
      </div>
    </div>
  );
}

/** Current request summary for the side column. */
export function RequestPanel({
  bundle
}: {
  bundle: RequestBundleOk;
}): ReactElement {
  return (
    <div className="chat-request-panel">
      {bundle.legacyV1 ? (
        <LegacyV1Note
          legacy={bundle.legacyV1}
          requestStatus={bundle.request.status}
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
    </div>
  );
}
