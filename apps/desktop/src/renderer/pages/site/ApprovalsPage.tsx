import type { ReactElement } from "react";

export function ApprovalsPage(): ReactElement {
  return (
    <article className="panel-card">
      <h1>Approvals</h1>
      <p className="lede">
        Pending approval items for destructive or publish actions will be listed
        here.
      </p>
      <p className="muted placeholder-note">
        Placeholder — approvals center UI.
      </p>
    </article>
  );
}
