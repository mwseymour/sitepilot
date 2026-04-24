import { useEffect, useState, type ReactElement } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";

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
    case "config":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-link-icon">
          <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M19 12a7 7 0 0 0-.08-1l2.05-1.6-2-3.46-2.47.8a7.1 7.1 0 0 0-1.72-1L14.5 3h-5l-.28 2.74a7.1 7.1 0 0 0-1.72 1l-2.47-.8-2 3.46L5.08 11a7 7 0 0 0 0 2l-2.05 1.6 2 3.46 2.47-.8a7.1 7.1 0 0 0 1.72 1L9.5 21h5l.28-2.74a7.1 7.1 0 0 0 1.72-1l2.47.8 2-3.46L18.92 13c.05-.33.08-.66.08-1Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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

function SiteWorkspaceChrome(): ReactElement {
  const { siteId, data, error, loading } = useSiteWorkspace();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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

  const links: { to: string; label: string; icon: string }[] = [
    { to: `overview`, label: "Overview", icon: "overview" },
    { to: `chat`, label: "Requests", icon: "requests" },
    { to: `config`, label: "Discovery check", icon: "config" },
    { to: `approvals`, label: "Approvals", icon: "approvals" },
    { to: `audit`, label: "Audit", icon: "audit" },
    { to: `diagnostics`, label: "Diagnostics", icon: "diagnostics" },
    { to: `settings`, label: "Settings", icon: "config" }
  ];

  return (
    <div
      className={`workspace-grid${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
    >
      <aside className="workspace-side">
        <div className="workspace-side-top">
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
              <path
                d="m14 6-6 6 6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <Link className="workspace-back" to="/">
          All sites
        </Link>
        <p className="eyebrow workspace-eyebrow">Site workspace</p>
        <h2 className="workspace-title">
          {loading ? "Loading…" : (data?.site.name ?? "Site")}
        </h2>
        {error ? <p className="workspace-error">{error}</p> : null}
        {!loading && data ? (
          <p
            className={`activation-pill activation-${data.site.activationStatus}`}
          >
            {data.site.activationStatus === "active"
              ? "Active"
              : data.site.activationStatus === "config_required"
                ? "Configuration required"
                : "Inactive"}
          </p>
        ) : null}
        <nav className="workspace-nav" aria-label="Workspace">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={`/site/${siteId}/${l.to}`}
              className={({ isActive }) =>
                `workspace-link${isActive ? " is-active" : ""}`
              }
              title={sidebarCollapsed ? l.label : undefined}
            >
              <span className="workspace-link-content">
                {renderNavIcon(l.icon)}
                <span className="workspace-link-label">{l.label}</span>
              </span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="workspace-main">
        <Outlet />
      </section>
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
