import type { ReactElement } from "react";

import type { GutenbergV2ExecutionState } from "@sitepilot/contracts";
import type { RequestStatus } from "@sitepilot/domain";

const STEPS = [
  "Request",
  "Details",
  "Update built",
  "Your review",
  "Apply",
  "Verified"
] as const;

type Position = { current: number; problem: boolean };

function position(
  requestStatus: RequestStatus | null,
  v2State: GutenbergV2ExecutionState | null,
  applying: boolean
): Position {
  if (applying) return { current: 4, problem: false };
  switch (v2State) {
    case "planned":
    case "compiling":
      return { current: 2, problem: false };
    case "review_ready":
      return { current: 3, problem: false };
    case "rejected":
      return { current: 3, problem: true };
    case "approved":
    case "preparing":
    case "committing":
    case "verifying":
      return { current: 4, problem: false };
    case "stale_approval":
    case "pre_write_failed":
      return { current: 4, problem: true };
    case "post_write_verification_failed":
    case "rolled_back":
    case "rollback_conflict":
    case "manual_intervention_required":
      return { current: 5, problem: true };
    case "succeeded":
      return { current: STEPS.length, problem: false };
    default:
      break;
  }
  if (requestStatus === null) return { current: 0, problem: false };
  if (requestStatus === "clarifying") return { current: 1, problem: false };
  if (requestStatus === "completed") return { current: STEPS.length, problem: false };
  if (requestStatus === "failed") return { current: 2, problem: true };
  return { current: 2, problem: false };
}

/** Where a request is: request → details → built → review → apply → verified. */
export function RequestStepper({
  requestStatus,
  v2State,
  applying
}: {
  requestStatus: RequestStatus | null;
  v2State: GutenbergV2ExecutionState | null;
  applying: boolean;
}): ReactElement {
  const { current, problem } = position(requestStatus, v2State, applying);
  return (
    <ol className="request-stepper" aria-label="Request progress">
      {STEPS.map((label, index) => {
        const state =
          index < current
            ? "done"
            : index === current
              ? problem
                ? "problem"
                : "current"
              : "todo";
        return (
          <li
            key={label}
            className={`request-step is-${state}`}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="request-step-mark" aria-hidden="true">
              {state === "done" ? "✓" : state === "problem" ? "!" : ""}
            </span>
            <span className="request-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
