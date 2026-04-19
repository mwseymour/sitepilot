import { useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import type { SiteSummary } from "@sitepilot/contracts";

export function HomePage(): ReactElement {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="app-shell home-shell">
      <section className="hero-card">
        <p className="eyebrow">SitePilot</p>
        <h1>Workspaces</h1>
        <p className="lede">
          Open a registered site to manage discovery, configuration, chat, and
          diagnostics. Site configuration must be confirmed before chat is
          enabled.
        </p>
      </section>
      {error ? <p className="workspace-error">{error}</p> : null}
      <section className="site-list">
        {sites.length === 0 ? (
          <article className="status-card">
            <h2>No sites yet</h2>
            <p>
              Register a site from the onboarding flow to see it listed here.
            </p>
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
                  {s.activationStatus === "active"
                    ? "Active"
                    : s.activationStatus === "config_required"
                      ? "Configuration required"
                      : "Inactive"}
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
