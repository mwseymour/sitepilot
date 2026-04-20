import type { ReactElement } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";

import {
  SiteWorkspaceProvider,
  useSiteWorkspace
} from "./site-workspace-context.js";

function SiteWorkspaceChrome(): ReactElement {
  const { siteId, data, error, loading } = useSiteWorkspace();

  const links: { to: string; label: string }[] = [
    { to: `overview`, label: "Overview" },
    { to: `chat`, label: "Chat" },
    { to: `config`, label: "Site config" },
    { to: `approvals`, label: "Approvals" },
    { to: `audit`, label: "Audit" },
    { to: `diagnostics`, label: "Diagnostics" },
    { to: `settings`, label: "Settings" }
  ];

  return (
    <div className="workspace-grid">
      <aside className="workspace-side">
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
            >
              {l.label}
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
