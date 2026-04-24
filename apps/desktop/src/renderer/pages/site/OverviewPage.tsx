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

  return (
    <article className="panel-card">
      <h1>Overview</h1>
      <p className="lede">
        <strong>{site.name}</strong> — {site.baseUrl}
      </p>
      <dl className="kv-grid">
        <div>
          <dt>Environment</dt>
          <dd>{site.environment}</dd>
        </div>
        <div>
          <dt>Activation</dt>
          <dd>{site.activationStatus}</dd>
        </div>
        <div>
          <dt>Discovery revision</dt>
          <dd>{discoveryRevision ?? "None"}</dd>
        </div>
        <div>
          <dt>Discovery check</dt>
          <dd>
            {discoveryRevision === null
              ? "Not run"
              : discoveryReviewRequired
                ? "Review needed"
                : "Up to date"}
          </dd>
        </div>
      </dl>
      <div className="action-row">
        <Link className="btn btn-secondary" to={`/site/${siteId}/diagnostics`}>
          Run diagnostics
        </Link>
        <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
          Discovery check
        </Link>
      </div>
    </article>
  );
}
