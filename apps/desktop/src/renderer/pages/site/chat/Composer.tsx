import { useRef, type ReactElement, type RefObject } from "react";

import type { ImageAttachmentPayload } from "@sitepilot/contracts";

import {
  AttachmentGrid,
  formatAttachmentCount,
  MAX_IMAGE_ATTACHMENTS
} from "./attachments.js";
import type { ComposerCopy } from "./request-view.js";
import type { GutenbergV2Operation } from "./types.js";

type ContentWorkflowFieldsetProps = {
  gutenbergV2Operation: GutenbergV2Operation;
  onGutenbergV2OperationChange: (operation: GutenbergV2Operation) => void;
  gutenbergV2PostType: "post" | "page";
  onGutenbergV2PostTypeChange: (postType: "post" | "page") => void;
  gutenbergV2PostId: string;
  onGutenbergV2PostIdChange: (postId: string) => void;
  /** Target controls lock while busy or once a v2 candidate exists. */
  targetLocked: boolean;
};

function ContentWorkflowFieldset({
  gutenbergV2Operation,
  onGutenbergV2OperationChange,
  gutenbergV2PostType,
  onGutenbergV2PostTypeChange,
  gutenbergV2PostId,
  onGutenbergV2PostIdChange,
  targetLocked
}: ContentWorkflowFieldsetProps): ReactElement {
  return (
    <fieldset className="chat-v2-controls composer-target">
      <legend className="visually-hidden">What to change</legend>
      <div className="chat-v2-target-grid">
        <label className="settings-field">
          <span>Operation</span>
          <select
            value={gutenbergV2Operation}
            disabled={targetLocked}
            onChange={(event) =>
              onGutenbergV2OperationChange(
                event.target.value as GutenbergV2Operation
              )
            }
          >
            <option value="create_draft">Create draft</option>
            <option value="replace_content">Replace all content</option>
            <option value="apply_operations">Apply selected changes</option>
            <option value="publish">Publish</option>
            <option value="unpublish">Unpublish (back to draft)</option>
          </select>
        </label>
        <label className="settings-field">
          <span>Content type</span>
          <select
            value={gutenbergV2PostType}
            disabled={targetLocked}
            onChange={(event) =>
              onGutenbergV2PostTypeChange(
                event.target.value as "post" | "page"
              )
            }
          >
            <option value="post">Post</option>
            <option value="page">Page</option>
          </select>
        </label>
        {gutenbergV2Operation !== "create_draft" ? (
          <label className="settings-field">
            <span>Post ID</span>
            <input
              type="number"
              min={1}
              step={1}
              value={gutenbergV2PostId}
              disabled={targetLocked}
              placeholder="e.g. 123"
              onChange={(event) =>
                onGutenbergV2PostIdChange(event.target.value)
              }
            />
          </label>
        ) : null}
      </div>
    </fieldset>
  );
}

type PendingAttachmentsProps = {
  attachments: ImageAttachmentPayload[];
  isConversationMode: boolean;
  preserveOriginalImageUploads: boolean;
  busy: boolean;
  onTogglePurpose: (index: number) => void;
  onRemove: (index: number) => void;
};

function PendingAttachments({
  attachments,
  isConversationMode,
  preserveOriginalImageUploads,
  busy,
  onTogglePurpose,
  onRemove
}: PendingAttachmentsProps): ReactElement {
  return (
    <div className="chat-composer-attachments">
      <p className="muted small-print">
        {formatAttachmentCount(attachments.length)} queued
      </p>
      <p className="muted small-print">
        {preserveOriginalImageUploads
          ? isConversationMode
            ? "Original image files will be sent at full size."
            : "Original image files will be kept at full size for planning and upload."
          : "Images are resized before planning so they are sent as compressed references instead of full-size originals."}
        {!isConversationMode
          ? " “Place in post” images are added to the content; “Layout reference” images and PDF pages are only used to work out what to build."
          : ""}
      </p>
      <AttachmentGrid
        attachments={attachments}
        keyFor={(attachment, index) =>
          `pending-${attachment.fileName}-${index}`
        }
        renderActions={(attachment, index) => (
          <>
            <button
              type="button"
              className={`chat-attachment-purpose${
                attachment.purpose === "reference" ? " is-reference" : ""
              }`}
              disabled={busy}
              title="Switch between placing this image in the content and using it only as a layout reference"
              onClick={() => onTogglePurpose(index)}
            >
              {attachment.purpose === "reference"
                ? "Layout reference"
                : "Place in post"}
            </button>
            <button
              type="button"
              className="chat-image-remove"
              onClick={() => {
                onRemove(index);
              }}
            >
              Remove
            </button>
          </>
        )}
      />
    </div>
  );
}

type ComposerProps = Omit<ContentWorkflowFieldsetProps, "targetLocked"> & {
  copy: ComposerCopy;
  isConversationMode: boolean;
  busy: boolean;
  /** False while an apply runs, so only the Apply button shows a spinner. */
  showSubmitSpinner: boolean;
  hasGutenbergV2State: boolean;
  gutenbergV2TargetValid: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  textareaRows: number;
  requestPrompt: string;
  onRequestPromptChange: (value: string) => void;
  onTextareaFocus: () => void;
  onTextareaKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  pendingAttachments: ImageAttachmentPayload[];
  preserveOriginalImageUploads: boolean;
  onPickAttachments: (fileList: FileList | null) => void;
  onToggleAttachmentPurpose: (index: number) => void;
  onRemoveAttachment: (index: number) => void;
  onSubmit: () => void;
};

export function Composer({
  copy,
  isConversationMode,
  busy,
  showSubmitSpinner,
  hasGutenbergV2State,
  gutenbergV2TargetValid,
  gutenbergV2Operation,
  onGutenbergV2OperationChange,
  gutenbergV2PostType,
  onGutenbergV2PostTypeChange,
  gutenbergV2PostId,
  onGutenbergV2PostIdChange,
  textareaRef,
  textareaRows,
  requestPrompt,
  onRequestPromptChange,
  onTextareaFocus,
  onTextareaKeyDown,
  pendingAttachments,
  preserveOriginalImageUploads,
  onPickAttachments,
  onToggleAttachmentPurpose,
  onRemoveAttachment,
  onSubmit
}: ComposerProps): ReactElement {
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  const showTarget = !isConversationMode && !hasGutenbergV2State;
  return (
    <div className="composer">
      {showTarget ? (
        <ContentWorkflowFieldset
          gutenbergV2Operation={gutenbergV2Operation}
          onGutenbergV2OperationChange={onGutenbergV2OperationChange}
          gutenbergV2PostType={gutenbergV2PostType}
          onGutenbergV2PostTypeChange={onGutenbergV2PostTypeChange}
          gutenbergV2PostId={gutenbergV2PostId}
          onGutenbergV2PostIdChange={onGutenbergV2PostIdChange}
          targetLocked={busy}
        />
      ) : null}
      <label className="visually-hidden" htmlFor="chat-composer-input">
        {copy.title}
      </label>
      <textarea
        id="chat-composer-input"
        ref={textareaRef}
        className="composer-input"
        rows={textareaRows}
        value={requestPrompt}
        placeholder={copy.placeholder}
        onFocus={onTextareaFocus}
        onKeyDown={onTextareaKeyDown}
        onChange={(e) => {
          onRequestPromptChange(e.target.value);
        }}
      />
      {pendingAttachments.length > 0 ? (
        <PendingAttachments
          attachments={pendingAttachments}
          isConversationMode={isConversationMode}
          preserveOriginalImageUploads={preserveOriginalImageUploads}
          busy={busy}
          onTogglePurpose={onToggleAttachmentPurpose}
          onRemove={onRemoveAttachment}
        />
      ) : null}
      <div className="composer-actions">
        <button
          type="button"
          className="composer-attach"
          disabled={busy || pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS}
          onClick={() => attachmentInputRef.current?.click()}
          title={isConversationMode ? "Add images" : "Add images or PDF"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l8-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{isConversationMode ? "Images" : "Images or PDF"}</span>
        </button>
        <span className="composer-helper">{copy.helper}</span>
        <button
          type="button"
          className="btn composer-send"
          disabled={
            busy ||
            requestPrompt.trim().length === 0 ||
            !gutenbergV2TargetValid
          }
          onClick={onSubmit}
          // Shows the spinner however the message was sent (click or ⌘↵).
          {...(showSubmitSpinner ? { "data-loading": "", "aria-busy": true } : {})}
        >
          {copy.actionLabel}
          <kbd className="btn-kbd">⌘↵</kbd>
        </button>
      </div>
      <input
        ref={attachmentInputRef}
        type="file"
        accept="image/*,application/pdf,video/mp4,video/webm"
        multiple
        hidden
        onChange={(event) => {
          onPickAttachments(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
