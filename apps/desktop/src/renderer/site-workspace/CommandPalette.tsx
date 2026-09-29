import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import { useNavigate } from "react-router-dom";

import type { SiteContentMatch, SiteSummary } from "@sitepilot/contracts";

import { chatPathFor, threadStatus } from "../status.js";
import { useSiteWorkspace } from "./site-workspace-context.js";

type Group = "content" | "requests" | "actions" | "sites";

type PaletteItem = {
  id: string;
  group: Group;
  label: string;
  meta?: string;
  hint?: string;
  run: () => void;
};

const GROUP_TITLES: Record<Group, string> = {
  content: "Posts and pages",
  requests: "Requests",
  actions: "Go to",
  sites: "Sites"
};

const FILTERS: Array<{ id: Group | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "content", label: "Posts and pages" },
  { id: "requests", label: "Requests" },
  { id: "actions", label: "Go to" },
  { id: "sites", label: "Sites" }
];

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function statusWord(status: string): string {
  switch (status) {
    case "publish":
      return "Published";
    case "draft":
      return "Draft";
    case "pending":
      return "Pending review";
    case "private":
      return "Private";
    case "future":
      return "Scheduled";
    default:
      return status;
  }
}

export function CommandPalette({
  onClose
}: {
  onClose: () => void;
}): ReactElement {
  const { siteId, data, activity } = useSiteWorkspace();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Group | "all">("all");
  const [active, setActive] = useState(0);
  const [content, setContent] = useState<SiteContentMatch[]>([]);
  const [contentState, setContentState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [sites, setSites] = useState<SiteSummary[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    void window.sitePilotDesktop.listSites().then((res) => {
      setSites(res.sites);
    });
  }, []);

  // Search the site as you type, debounced so each keystroke isn't a request.
  const siteActive = data?.site.activationStatus === "active";
  useEffect(() => {
    if (!siteActive) return;
    let cancelled = false;
    setContentState("loading");
    const timer = window.setTimeout(() => {
      void window.sitePilotDesktop
        .searchSiteContent({ siteId, query })
        .then((res) => {
          if (cancelled) return;
          if (res.ok) {
            setContent(res.matches);
            setContentState("idle");
          } else {
            setContent([]);
            setContentState("error");
          }
        })
        .catch(() => {
          if (!cancelled) setContentState("error");
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, siteId, siteActive]);

  const items = useMemo((): PaletteItem[] => {
    const go = (path: string) => () => {
      onClose();
      navigate(path);
    };
    const q = query.trim();
    const list: PaletteItem[] = [];

    for (const match of content) {
      const writable = match.postType === "post" || match.postType === "page";
      const kind = match.postType === "page" ? "Page" : match.postType === "post" ? "Post" : match.postType;
      list.push({
        id: `content-${match.postId}`,
        group: "content",
        label: match.title || "(no title)",
        meta: [
          `${kind} #${match.postId}`,
          statusWord(match.status),
          match.slug ? `/${match.slug}` : null
        ]
          .filter(Boolean)
          .join(" · "),
        hint: writable ? "New request on it" : "Open a conversation",
        run: writable
          ? go(
              `/site/${siteId}/chat?new=1&postId=${match.postId}&postType=${match.postType}`
            )
          : go(`/site/${siteId}/conversations?new=1`)
      });
    }

    for (const thread of activity) {
      if (q && !matches(thread.title, q)) continue;
      list.push({
        id: `thread-${thread.threadId}`,
        group: "requests",
        label: thread.title,
        meta: threadStatus(thread).label,
        run: go(chatPathFor(siteId, thread))
      });
    }

    const actions: Array<[string, string]> = [
      ["New request", `/site/${siteId}/chat?new=1`],
      ["New conversation", `/site/${siteId}/conversations?new=1`],
      ["Home", `/site/${siteId}/overview`],
      ["All requests", `/site/${siteId}/requests`],
      ["All conversations", `/site/${siteId}/conversations-list`],
      ["Approvals", `/site/${siteId}/approvals`],
      ["Diagnostics", `/site/${siteId}/diagnostics`],
      ["Discovery check", `/site/${siteId}/config`],
      ["Audit log", `/site/${siteId}/audit`],
      ["Site settings", `/site/${siteId}/settings`],
      ["App settings", `/settings`]
    ];
    for (const [label, path] of actions) {
      if (q && !matches(label, q)) continue;
      list.push({ id: `action-${label}`, group: "actions", label, run: go(path) });
    }

    for (const site of sites) {
      if (site.id === siteId) continue;
      if (q && !matches(`${site.name} ${site.baseUrl}`, q)) continue;
      list.push({
        id: `site-${site.id}`,
        group: "sites",
        label: `Switch to ${site.name}`,
        meta: site.baseUrl.replace(/^https?:\/\//, ""),
        run: go(`/site/${site.id}/overview`)
      });
    }

    return filter === "all" ? list : list.filter((item) => item.group === filter);
  }, [activity, content, filter, navigate, onClose, query, siteId, sites]);

  useEffect(() => {
    setActive(0);
  }, [query, filter]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(items.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[active]?.run();
    }
  };

  let index = -1;
  const groups = (Object.keys(GROUP_TITLES) as Group[])
    .map((group) => ({
      group,
      rows: items.filter((item) => item.group === group)
    }))
    .filter((entry) => entry.rows.length > 0);

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
      >
        <div className="palette-input-row">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="palette-search-icon">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="palette-input"
            aria-label="Search posts, pages, requests and sites"
            placeholder="Search by title, slug or post ID…"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={items[active] ? `palette-${items[active]!.id}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <kbd className="rail-kbd">esc</kbd>
        </div>
        <div className="palette-filters" role="group" aria-label="Filter">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`palette-filter${filter === option.id ? " is-active" : ""}`}
              aria-pressed={filter === option.id}
              onClick={() => {
                setFilter(option.id);
                inputRef.current?.focus();
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="palette-results" id="palette-results" role="listbox" ref={listRef}>
          {groups.map(({ group, rows }) => (
            <div key={group} role="group" aria-label={GROUP_TITLES[group]}>
              <div className="palette-group-title">
                {GROUP_TITLES[group]}
                {group === "content" && data ? ` on ${data.site.name}` : ""}
              </div>
              {rows.map((item) => {
                index += 1;
                const rowIndex = index;
                return (
                  <div
                    key={item.id}
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={rowIndex === active}
                    data-index={rowIndex}
                    className={`palette-row${rowIndex === active ? " is-active" : ""}`}
                    onMouseMove={() => {
                      setActive(rowIndex);
                    }}
                    onClick={item.run}
                  >
                    <span className="palette-row-copy">
                      <span className="palette-row-label">{item.label}</span>
                      {item.meta ? (
                        <span className="palette-row-meta">{item.meta}</span>
                      ) : null}
                    </span>
                    {rowIndex === active && item.hint ? (
                      <span className="palette-row-hint">↵ {item.hint}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
          {items.length === 0 ? (
            <p className="palette-empty">
              {contentState === "loading" ? "Searching the site…" : "Nothing matches that."}
            </p>
          ) : null}
        </div>
        <div className="palette-footer">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span className="palette-footer-spacer" />
          <span>
            {!siteActive
              ? "Post search is available once the site is active"
              : contentState === "loading"
                ? "Searching the site…"
                : contentState === "error"
                  ? "Couldn’t search the site right now"
                  : "Searches post titles, slugs and IDs"}
          </span>
        </div>
      </div>
    </div>
  );
}
