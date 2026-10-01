import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";

import type { SiteSummary } from "@sitepilot/contracts";

import { modePageCopy } from "../chat-workflow.js";
import { isHostedApp } from "../hosted.js";
import { activationLabel } from "../site-labels.js";
import { chatPathFor, formatWhen, targetLabel, threadStatus } from "../status.js";
import { ThemeToggle } from "../theme/theme.js";
import { CommandPalette } from "./CommandPalette.js";
import {
  SiteWorkspaceProvider,
  useSiteWorkspace
} from "./site-workspace-context.js";

function renderNavIcon(kind: string): ReactElement {
  switch (kind) {
    case "overview":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "requests":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M6 5h12M6 10h12M6 15h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "conversations":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v5A2.5 2.5 0 0 1 16.5 15H11l-4 4v-4H7.5A2.5 2.5 0 0 1 5 12.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "config":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M19 12a7 7 0 0 0-.08-1l2.05-1.6-2-3.46-2.47.8a7.1 7.1 0 0 0-1.72-1L14.5 3h-5l-.28 2.74a7.1 7.1 0 0 0-1.72 1l-2.47-.8-2 3.46L5.08 11a7 7 0 0 0 0 2l-2.05 1.6 2 3.46 2.47-.8a7.1 7.1 0 0 0 1.72 1L9.5 21h5l.28-2.74a7.1 7.1 0 0 0 1.72-1l2.47.8 2-3.46L18.92 13c.05-.33.08-.66.08-1Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "checklist":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <rect x="5" y="4.5" width="14" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M9 3.5h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M8.5 9h7M8.5 13h7M8.5 17h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m6.8 8.7.8.8 1.4-1.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m6.8 12.7.8.8 1.4-1.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m6.8 16.7.8.8 1.4-1.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "approvals":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="m9 12 2 2 4-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 3 5 6v6c0 5 3.4 7.9 7 9 3.6-1.1 7-4 7-9V6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      );
    case "audit":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M8 7h8M8 12h8M8 17h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M6 4h12a1 1 0 0 1 1 1v14l-3-2-3 2-3-2-3 2V5a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case "diagnostics":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M5 19h14M7 16l3-4 3 2 4-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}

const ENVIRONMENT_LABEL: Record<SiteSummary["environment"], string> = {
  production: "Production",
  staging: "Staging",
  development: "Development"
};

function SiteSwitcher({
  currentSiteId,
  name,
  environment
}: {
  currentSiteId: string;
  name: string;
  environment: SiteSummary["environment"] | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.sitePilotDesktop.listSites().then((res) => {
      setSites(res.sites);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="rail-switcher" ref={rootRef}>
      <button
        type="button"
        className="rail-switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <span className="rail-monogram" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="rail-switcher-copy">
          <span className="rail-switcher-name">{name}</span>
          <span className="rail-switcher-meta">
            {environment ? ENVIRONMENT_LABEL[environment] : "Site"}
          </span>
        </span>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="rail-icon">
          <path d="M8 9l4-4 4 4M8 15l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="rail-menu" role="menu">
          {sites.map((site) => (
            <Link
              key={site.id}
              role="menuitem"
              className={`rail-menu-item${site.id === currentSiteId ? " is-current" : ""}`}
              to={`/site/${site.id}/overview`}
              onClick={() => {
                setOpen(false);
              }}
            >
              <span className="rail-monogram is-small" aria-hidden="true">
                {initials(site.name)}
              </span>
              <span className="rail-switcher-copy">
                <span className="rail-switcher-name">{site.name}</span>
                <span className="rail-switcher-meta">
                  {ENVIRONMENT_LABEL[site.environment]} ·{" "}
                  {site.baseUrl.replace(/^https?:\/\//, "")}
                </span>
              </span>
            </Link>
          ))}
          <div className="rail-menu-divider" />
          {isHostedApp() ? (
            <>
              <a role="menuitem" className="rail-menu-item" href="/account">
                Account and tokens
              </a>
              <form method="post" action="/auth/sign-out">
                <button type="submit" role="menuitem" className="rail-menu-item">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link role="menuitem" className="rail-menu-item" to="/">
                All sites
              </Link>
              <Link role="menuitem" className="rail-menu-item" to="/sites/new">
                Add a site
              </Link>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SiteWorkspaceChrome(): ReactElement {
  const { siteId, data, error, loading, activity, paletteOpen, setPaletteOpen } =
    useSiteWorkspace();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const activeThreadId = searchParams.get("thread");
  // Thread views fill the window; list pages scroll like other pages.
  const path = location.pathname;
  const chatMode = /\/conversations(-list)?$/.test(path)
    ? "conversation"
    : /\/(chat|requests)$/.test(path)
      ? "request"
      : null;
  const onThreadView = /\/(chat|conversations)$/.test(path);

  useEffect(() => {
    const stored = window.localStorage.getItem("sitepilot-workspace-sidebar");
    setSidebarCollapsed(stored === "collapsed");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "sitepilot-workspace-sidebar",
      sidebarCollapsed ? "collapsed" : "expanded"
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen, setPaletteOpen]);

  const reviewCount = activity.filter(
    (thread) =>
      thread.v2State === "review_ready" || thread.v2State === "approved"
  ).length;

  const links: {
    to: string;
    label: string;
    icon: string;
    navHint?: string;
    badge?: number;
  }[] = [
    { to: `overview`, label: "Home", icon: "overview" },
    {
      to: `requests`,
      label: "Requests",
      icon: "requests",
      navHint: modePageCopy("request").navHint
    },
    {
      to: `conversations-list`,
      label: "Conversations",
      icon: "conversations",
      navHint: modePageCopy("conversation").navHint
    },
    {
      to: `approvals`,
      label: "Approvals",
      icon: "approvals",
      ...(reviewCount > 0 ? { badge: reviewCount } : {})
    },
    { to: `config`, label: "Discovery check", icon: "checklist" },
    { to: `diagnostics`, label: "Diagnostics", icon: "diagnostics" },
    { to: `audit`, label: "Audit", icon: "audit" },
    { to: `settings`, label: "Settings", icon: "config" }
  ];

  const recent = activity
    .filter((thread) => thread.type !== "conversation")
    .slice(0, 6);
  const newPath =
    chatMode === "conversation"
      ? `/site/${siteId}/conversations?new=1`
      : `/site/${siteId}/chat?new=1`;
  const newLabel = chatMode === "conversation" ? "New conversation" : "New request";
  const siteName = loading ? "Loading…" : (data?.site.name ?? "Site");

  return (
    <div
      className={`workspace-grid${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
    >
      <aside className="workspace-side rail">
        <div className="rail-top">
          <SiteSwitcher
            currentSiteId={siteId}
            name={siteName}
            environment={data?.site.environment ?? null}
          />
          <button
            type="button"
            className="workspace-sidebar-toggle"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              setSidebarCollapsed((current) => !current);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className={`workspace-toggle-icon${sidebarCollapsed ? " is-collapsed" : ""}`}
            >
              <path d="m14 6-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {error ? <p className="workspace-error">{error}</p> : null}

        <button
          type="button"
          className="rail-search"
          onClick={() => {
            setPaletteOpen(true);
          }}
          title="Search posts, requests and sites (⌘K)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="rail-icon">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span className="rail-search-label">Search</span>
          <kbd className="rail-kbd">⌘K</kbd>
        </button>

        <button
          type="button"
          className="btn btn-primary rail-new"
          onClick={() => {
            navigate(newPath);
          }}
          title={newLabel}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="rail-icon">
            <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="rail-new-label">{newLabel}</span>
        </button>

        <nav className="workspace-nav" aria-label="Workspace">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={`/site/${siteId}/${l.to}`}
              className={({ isActive }) =>
                `workspace-link${isActive || (l.to === "requests" && chatMode === "request" && onThreadView) || (l.to === "conversations-list" && chatMode === "conversation" && onThreadView) ? " is-active" : ""}`
              }
              title={sidebarCollapsed ? l.label : l.navHint}
            >
              <span className="workspace-link-content">
                {renderNavIcon(l.icon)}
                <span className="workspace-link-copy">
                  <span className="workspace-link-label">{l.label}</span>
                </span>
                {l.badge ? (
                  <span className="rail-badge" aria-label={`${l.badge} waiting`}>
                    {l.badge}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
        </nav>

        {recent.length > 0 ? (
          <section className="rail-recent" aria-labelledby="rail-recent-heading">
            <h2 id="rail-recent-heading" className="rail-section-title">
              Recent requests
            </h2>
            {recent.map((thread) => {
              const status = threadStatus(thread);
              const target = targetLabel(thread);
              return (
                <Link
                  key={thread.threadId}
                  to={chatPathFor(siteId, thread)}
                  className={`rail-thread${thread.threadId === activeThreadId ? " is-active" : ""}`}
                  aria-current={thread.threadId === activeThreadId ? "page" : undefined}
                >
                  {thread.type === "conversation" ? null : (
                    <span className={`status-dot tone-${status.tone}`} aria-hidden="true" />
                  )}
                  <span className="rail-thread-copy">
                    <span className="rail-thread-title">{thread.title}</span>
                    <span className="rail-thread-meta">
                      {thread.type === "conversation"
                        ? formatWhen(thread.updatedAt)
                        : `${target ? `${target} · ` : ""}${status.label}`}
                    </span>
                  </span>
                </Link>
              );
            })}
          </section>
        ) : null}

        <div className="rail-footer">
          {!loading && data ? (
            <span className="rail-connection">
              <span
                className={`status-dot tone-${data.site.activationStatus === "active" ? "done" : data.site.activationStatus === "config_required" ? "waiting" : "neutral"}`}
                aria-hidden="true"
              />
              <span className="rail-connection-label">
                {activationLabel(data.site.activationStatus)}
              </span>
            </span>
          ) : (
            <span />
          )}
          <span className="rail-footer-actions">
            <ThemeToggle className="icon-btn" />
            <Link className="icon-btn" to="/settings" aria-label="App settings" title="App settings">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="16" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="10" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="18" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </Link>
          </span>
        </div>
      </aside>
      <section className={`workspace-main${onThreadView ? " is-flush" : ""}`}>
        <Outlet />
      </section>
      {paletteOpen ? (
        <CommandPalette
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function SiteWorkspaceLayout(): ReactElement {
  const { siteId } = useParams<{ siteId: string }>();
  if (!siteId) {
    return <p className="workspace-error">Missing site id.</p>;
  }

  return (
    <SiteWorkspaceProvider siteId={siteId}>
      <SiteWorkspaceChrome />
    </SiteWorkspaceProvider>
  );
}
