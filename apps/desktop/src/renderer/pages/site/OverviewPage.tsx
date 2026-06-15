import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

export function OverviewPage(): ReactElement | null {
  const { siteId, data, loading } = useSiteWorkspace();

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  const { site, discoveryRevision, discoveryReviewRequired } = data;
  const discoveryStatus =
    discoveryRevision === null
      ? "Not run"
      : discoveryReviewRequired
        ? "Review needed"
        : "Up to date";

  return (
    <article className="panel-card overview-page">
      <header className="overview-header">
        <div>
          <p className="eyebrow">Workspace overview</p>
          <h1>{site.name}</h1>
          <p className="lede">{site.baseUrl}</p>
        </div>
        <p className={`activation-pill activation-${site.activationStatus}`}>
          {site.activationStatus === "active"
            ? "Active"
            : site.activationStatus === "config_required"
              ? "Configuration required"
              : "Inactive"}
        </p>
      </header>
      <dl className="overview-stat-grid">
        <div className="overview-stat">
          <dt>Environment</dt>
          <dd>{site.environment}</dd>
        </div>
        <div className="overview-stat">
          <dt>Discovery revision</dt>
          <dd>{discoveryRevision ?? "None"}</dd>
        </div>
        <div className="overview-stat">
          <dt>Discovery check</dt>
          <dd>{discoveryStatus}</dd>
        </div>
      </dl>
      <section className="overview-next-step">
        <div>
          <p className="eyebrow">Recommended next step</p>
          <h2>
            {discoveryReviewRequired
              ? "Review the latest discovery changes"
              : "Your site setup is ready"}
          </h2>
          <p className="muted">
            {discoveryReviewRequired
              ? "A newer discovery snapshot is available. Review it before making more site changes."
              : "Run diagnostics at any time, or open the discovery check to review the active setup."}
          </p>
        </div>
        <div className="action-row">
          <Link
            className="btn btn-secondary"
            to={`/site/${siteId}/diagnostics`}
          >
            Run diagnostics
          </Link>
          <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
            Discovery check
          </Link>
        </div>
      </section>
    </article>
  );
}
