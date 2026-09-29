import type { ReactElement, RefObject } from "react";

import { AttachmentGrid } from "./attachments.js";
import { formatWhen } from "../../../status.js";
import {
  clarificationLines,
  roleClassName,
  roleLabel
} from "./message-format.js";
import type { MessageFilter, MessageRow } from "./types.js";

const MESSAGE_FILTER_OPTIONS: Array<{ value: MessageFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "non_system", label: "Hide system" },
  { value: "system_only", label: "System only" }
];

export function MessageFilterBar({
  messageFilter,
  systemMessageCount,
  onChange
}: {
  messageFilter: MessageFilter;
  systemMessageCount: number;
  onChange: (filter: MessageFilter) => void;
}): ReactElement {
  return (
    <div className="chat-message-filters" aria-label="Message filters">
      <div className="chat-message-filter-group" role="group">
        {MESSAGE_FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={
              messageFilter === option.value
                ? "chat-message-filter is-active"
                : "chat-message-filter"
            }
            aria-pressed={messageFilter === option.value}
            onClick={() => {
              onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {systemMessageCount > 0 ? (
        <p className="chat-message-filter-summary muted small-print">
          {systemMessageCount} system{" "}
          {systemMessageCount === 1 ? "message" : "messages"}
        </p>
      ) : null}
    </div>
  );
}

const URL_PATTERN = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;

/** Plain text with web addresses turned into links (opened in the browser). */
function Linkified({ text }: { text: string }): ReactElement {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a key={index} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        )
      )}
    </>
  );
}

function MessageBody({ message }: { message: MessageRow }): ReactElement {
  const clarification = clarificationLines(message);
  if (!clarification) {
    const technicalDetails = message.body.technicalDetails;
    if (technicalDetails === undefined) {
      return (
        <p className="chat-msg-body">
          <Linkified text={message.body.value} />
        </p>
      );
    }
    // Plain language first; the raw diagnostic report stays one click away.
    return (
      <div className="chat-msg-body">
        <p className="chat-msg-body-lead">
          <Linkified text={message.body.value} />
        </p>
        <details className="chat-msg-technical">
          <summary>Show technical details</summary>
          <pre>{technicalDetails}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className="chat-msg-body chat-msg-body-clarification">
      {clarification.intro.map((line) => (
        <p key={line} className="chat-msg-body-lead">
          {line}
        </p>
      ))}
      {clarification.questionLabel ? (
        <p className="chat-msg-question-label">
          <strong>{clarification.questionLabel}</strong>
        </p>
      ) : null}
      <div className="chat-msg-question-list">
        {clarification.questions.map((question) => (
          <p key={question} className="chat-msg-question">
            <strong>{question}</strong>
          </p>
        ))}
      </div>
    </div>
  );
}

function authorKind(m: MessageRow): "user" | "assistant" | "system" {
  const role = roleClassName(m);
  return role === "chat-msg-user"
    ? "user"
    : role === "chat-msg-assistant"
      ? "assistant"
      : "system";
}

export function MessageList({
  messages,
  containerRef
}: {
  messages: MessageRow[];
  containerRef: RefObject<HTMLDivElement | null>;
}): ReactElement {
  return (
    <div ref={containerRef} className="chat-messages">
      {messages.map((m) => {
        const kind = authorKind(m);
        const when = (
          <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
            {formatWhen(m.createdAt)}
          </time>
        );
        const attachments =
          m.attachments && m.attachments.length > 0 ? (
            <AttachmentGrid
              attachments={m.attachments}
              keyFor={(attachment) => `${m.id}-${attachment.fileName}`}
            />
          ) : null;

        if (kind === "system") {
          // Status notes from the app read as a thin timeline line.
          return (
            <div key={m.id} className="chat-event" role="note">
              <span className="chat-event-rule" aria-hidden="true" />
              <div className="chat-event-copy">
                <MessageBody message={m} />
              </div>
              {when}
              <span className="chat-event-rule is-grow" aria-hidden="true" />
            </div>
          );
        }

        if (kind === "user") {
          return (
            <article key={m.id} className="chat-turn is-user">
              <header className="chat-turn-meta">
                {roleLabel(m)} · {when}
              </header>
              <div className="chat-bubble">
                <MessageBody message={m} />
              </div>
              {attachments}
            </article>
          );
        }

        return (
          <article key={m.id} className="chat-turn is-assistant">
            <span className="chat-avatar" aria-hidden="true">
              SP
            </span>
            <div className="chat-turn-main">
              <header className="chat-turn-meta">SitePilot · {when}</header>
              <div className="chat-card">
                <MessageBody message={m} />
              </div>
              {attachments}
            </div>
          </article>
        );
      })}
    </div>
  );
}
