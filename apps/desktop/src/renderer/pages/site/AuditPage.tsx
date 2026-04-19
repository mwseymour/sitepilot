import type { ReactElement } from "react";

export function AuditPage(): ReactElement {
  return (
    <article className="panel-card">
      <h1>Audit log</h1>
      <p className="lede">
        Immutable audit entries for plans, approvals, execution, and rollbacks
        will be queryable from this screen.
      </p>
      <p className="muted placeholder-note">Placeholder — audit UI.</p>
    </article>
  );
}
