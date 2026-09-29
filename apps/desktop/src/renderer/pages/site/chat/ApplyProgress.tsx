import { useEffect, useState, type ReactElement } from "react";

import type { GutenbergV2ExecutionState } from "@sitepilot/contracts";

const PHASES: Array<{
  states: GutenbergV2ExecutionState[];
  label: string;
  detail: string;
}> = [
  {
    states: ["approved", "preparing"],
    label: "Checking the page hasn’t changed since review",
    detail: "Compares the site with the version you approved"
  },
  {
    states: ["committing"],
    label: "Saving in one transaction",
    detail: "Writes content, fields and media together"
  },
  {
    states: ["verifying"],
    label: "Reopening and verifying each block",
    detail: "Loads the saved page in a fresh editor and compares it"
  }
];

/**
 * Live progress while an approved update is written. The state comes from
 * the execution journal, polled while the apply call is running.
 */
export function ApplyProgress({
  state,
  startedAt
}: {
  state: GutenbergV2ExecutionState | null;
  startedAt: number;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const activeIndex = Math.max(
    0,
    PHASES.findIndex((phase) => state !== null && phase.states.includes(state))
  );
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));

  return (
    <section className="apply-progress card" role="status" aria-live="polite">
      <div className="apply-progress-top">
        <span className="spinner" aria-hidden="true" />
        <h4>Applying to the site</h4>
        <span className="apply-progress-time">
          Step {activeIndex + 1} of {PHASES.length} · {seconds}s
        </span>
      </div>
      <ol className="apply-progress-steps">
        {PHASES.map((phase, index) => {
          const status =
            index < activeIndex ? "done" : index === activeIndex ? "current" : "todo";
          return (
            <li key={phase.label} className={`apply-step is-${status}`}>
              <span className="apply-step-mark" aria-hidden="true">
                {status === "done" ? "✓" : index + 1}
              </span>
              <span className="apply-step-copy">
                <span className="apply-step-label">{phase.label}</span>
                <span className="apply-step-detail">{phase.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="apply-progress-note">
        If a check fails, SitePilot puts the previous version back on its own,
        unless someone has edited the page since.
      </p>
    </section>
  );
}
