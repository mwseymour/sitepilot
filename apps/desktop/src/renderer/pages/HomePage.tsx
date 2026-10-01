import { useEffect, useState, type ReactElement } from "react";
import { Link, Navigate } from "react-router-dom";

import type { SiteSummary } from "@sitepilot/contracts";

import { isHostedApp } from "../hosted.js";
import { activationLabel } from "../site-labels.js";
import { ThemeToggle } from "../theme/theme.js";

export function HomePage(): ReactElement {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hosted = isHostedApp();

  useEffect(() => {
    let cancelled = false;
    void window.sitePilotDesktop.listSites({}).then(
      (res) => {
        if (!cancelled) {
          setSites(res.sites);
        }
      },
      () => {
        if (!cancelled) {
          setError("Could not load sites.");
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The hosted app manages one site: open it.
  if (hosted && sites.length === 1 && sites[0]) {
    return <Navigate to={`/site/${sites[0].id}/overview`} replace />;
  }

  return (
    <main className="app-shell home-shell">
      <section className="hero-card">
        <p className="eyebrow">SitePilot</p>
        <h1>Workspaces</h1>
        <p className="lede">
          Open a registered site to manage discovery, discovery checks, chat, and
          diagnostics. The latest reviewed setup must be confirmed before chat is
          enabled.
        </p>
        <div className="action-row">
          {hosted ? (
            <a className="btn btn-secondary btn-small" href="/account">
              Account and tokens
            </a>
          ) : (
            <Link className="btn btn-primary" to="/sites/new">
              Add site
            </Link>
          )}
          <Link className="btn btn-secondary btn-small" to="/settings">
            App settings
          </Link>
          <ThemeToggle className="icon-btn" />
        </div>
      </section>
      {error ? <p className="workspace-error">{error}</p> : null}
      <section className="site-list">
        {sites.length === 0 ? (
          <article className="status-card">
            <h2>No sites yet</h2>
            {hosted ? (
              <>
                <p>Connect the WordPress site this SitePilot manages.</p>
                <a className="btn btn-primary" href="/sites/connect">
                  Connect the site
                </a>
              </>
            ) : (
              <>
                <p>Register a WordPress site to see it listed here.</p>
                <Link className="btn btn-primary" to="/sites/new">
                  Add your first site
                </Link>
              </>
            )}
          </article>
        ) : (
          sites.map((s) => (
            <article key={s.id} className="status-card site-card">
              <div>
                <h2>{s.name}</h2>
                <p className="site-url">{s.baseUrl}</p>
                <p
                  className={`activation-pill activation-${s.activationStatus}`}
                >
                  {activationLabel(s.activationStatus)}
                </p>
              </div>
              <Link className="btn btn-primary" to={`/site/${s.id}/overview`}>
                Open workspace
              </Link>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
