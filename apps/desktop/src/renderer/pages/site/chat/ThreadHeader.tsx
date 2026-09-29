import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject
} from "react";

import { Link } from "react-router-dom";

import type { ThreadRow } from "./types.js";

/**
 * Thread title, target chips and progress. Rename and delete live in the
 * options menu now that the thread list is in the sidebar.
 */
export function ThreadHeader({
  backTo,
  backLabel,
  thread,
  fallbackTitle,
  chips,
  progress,
  filter,
  isEditing,
  editingTitle,
  renameInputRef,
  renaming,
  pendingDelete,
  deleting,
  busy,
  onStartRename,
  onEditingTitleChange,
  onSubmitRename,
  onCancelRename,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  itemLabel
}: {
  backTo: string;
  backLabel: string;
  thread: ThreadRow | null;
  fallbackTitle: string;
  chips: string[];
  progress: ReactNode;
  filter: ReactNode;
  isEditing: boolean;
  editingTitle: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  renaming: boolean;
  pendingDelete: boolean;
  deleting: boolean;
  busy: boolean;
  onStartRename: () => void;
  onEditingTitleChange: (title: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  itemLabel: string;
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="thread-header">
      <div className="thread-header-top">
        <Link
          className="icon-btn thread-back"
          to={backTo}
          aria-label={backLabel}
          title={backLabel}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        {isEditing ? (
          <form
            className="thread-rename"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitRename();
            }}
          >
            <label className="visually-hidden" htmlFor="thread-rename-input">
              {`Rename ${itemLabel}`}
            </label>
            <input
              id="thread-rename-input"
              ref={renameInputRef}
              value={editingTitle}
              disabled={renaming}
              onChange={(event) => onEditingTitleChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelRename();
                }
              }}
            />
            <button type="submit" className="btn btn-primary btn-small" disabled={renaming}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={renaming}
              onClick={onCancelRename}
            >
              Cancel
            </button>
          </form>
        ) : (
          <h1 className="display-title thread-title">
            {thread?.title ?? fallbackTitle}
          </h1>
        )}
        <div className="thread-menu" ref={menuRef}>
          <button
            type="button"
            className="icon-btn thread-menu-button"
            aria-label={`${itemLabel} options`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={!thread || busy}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="19" cy="12" r="1.6" fill="currentColor" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="rail-menu thread-menu-list" role="menu">
              <button
                type="button"
                role="menuitem"
                className="rail-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onStartRename();
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="rail-menu-item is-danger"
                onClick={() => {
                  setMenuOpen(false);
                  onRequestDelete();
                }}
              >
                {`Delete ${itemLabel}`}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {pendingDelete ? (
        <div className="thread-delete" role="alert">
          <span>{`Delete this ${itemLabel} and its history?`}</span>
          <button
            type="button"
            className="btn btn-danger btn-small"
            disabled={deleting}
            onClick={onConfirmDelete}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={deleting}
            onClick={onCancelDelete}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {chips.length > 0 || filter ? (
        <div className="thread-chips">
          {chips.map((chip) => (
            <span key={chip} className="thread-chip">
              {chip}
            </span>
          ))}
          <span className="thread-chips-spacer" />
          {filter}
        </div>
      ) : null}
      {progress}
    </header>
  );
}
