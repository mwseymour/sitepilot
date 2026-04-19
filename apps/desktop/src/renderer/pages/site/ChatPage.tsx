import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { useSiteWorkspace } from "../../site-workspace/site-workspace-context.js";

export function ChatPage(): ReactElement | null {
  const { siteId, data, loading } = useSiteWorkspace();

  if (loading) {
    return <p className="muted">Loading workspace…</p>;
  }

  if (!data) {
    return null;
  }

  const chatEnabled = data.site.activationStatus === "active";

  if (!chatEnabled) {
    return (
      <article className="panel-card gate-card">
        <h1>Chat disabled</h1>
        <p className="lede">
          Chat stays off until site configuration is reviewed and activation
          completes. Finish your site config and confirm it to enable chat for
          this site.
        </p>
        <Link className="btn btn-primary" to={`/site/${siteId}/config`}>
          Go to site configuration
        </Link>
      </article>
    );
  }

  return (
    <article className="panel-card">
      <h1>Chat</h1>
      <p className="lede">
        Chat threads and request flow will appear here (request lifecycle is
        tracked in later milestones).
      </p>
      <p className="muted placeholder-note">
        Placeholder — connect threads UI.
      </p>
    </article>
  );
}
