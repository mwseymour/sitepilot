import type {
  GutenbergV2ExecutionState,
  SiteActivityThread
} from "@sitepilot/contracts";

/** One colour family per status, shared by the sidebar, Home and chat. */
export type StatusTone =
  | "review"
  | "waiting"
  | "approved"
  | "running"
  | "done"
  | "rolled-back"
  | "attention"
  | "neutral";

export type ThreadStatus = { label: string; tone: StatusTone };

export function minutesUntil(iso: string, now = Date.now()): number {
  return Math.ceil((Date.parse(iso) - now) / 60_000);
}

export function v2StateStatus(
  state: GutenbergV2ExecutionState,
  options: { approvalExpiresAt?: string; publishing?: boolean } = {}
): ThreadStatus {
  switch (state) {
    case "planned":
    case "compiling":
      return { label: "Building the update", tone: "neutral" };
    case "review_ready":
      return { label: "Ready for review", tone: "review" };
    case "approved": {
      if (!options.approvalExpiresAt) return { label: "Approved", tone: "approved" };
      const left = minutesUntil(options.approvalExpiresAt);
      return left > 0
        ? { label: `Approved · ${left} min left`, tone: "approved" }
        : { label: "Approval expired", tone: "attention" };
    }
    case "preparing":
    case "committing":
    case "verifying":
      return { label: "Applying", tone: "running" };
    case "succeeded":
      return {
        label: options.publishing ? "Done, status changed" : "Done, verified",
        tone: "done"
      };
    case "rejected":
      return { label: "Rejected", tone: "neutral" };
    case "stale_approval":
      return { label: "Page changed since review", tone: "attention" };
    case "pre_write_failed":
      return { label: "Not saved, nothing changed", tone: "attention" };
    case "post_write_verification_failed":
      return { label: "Verification needs attention", tone: "attention" };
    case "rolled_back":
      return { label: "Rolled back safely", tone: "rolled-back" };
    case "rollback_conflict":
      return { label: "Rollback needs attention", tone: "attention" };
    case "manual_intervention_required":
      return { label: "Needs attention", tone: "attention" };
  }
}

export function threadStatus(thread: SiteActivityThread): ThreadStatus {
  if (thread.v2State) {
    return v2StateStatus(thread.v2State, {
      ...(thread.approvalExpiresAt
        ? { approvalExpiresAt: thread.approvalExpiresAt }
        : {}),
      publishing: thread.target?.operation === "set_status"
    });
  }
  switch (thread.requestStatus) {
    case "clarifying":
      return { label: "Waiting for your answer", tone: "waiting" };
    case "new":
    case "drafted":
      return { label: "Draft request", tone: "neutral" };
    case "awaiting_approval":
      return { label: "Needs approval", tone: "review" };
    case "approved":
      return { label: "Approved", tone: "approved" };
    case "executing":
      return { label: "Applying", tone: "running" };
    case "completed":
      return { label: "Done", tone: "done" };
    case "partially_completed":
      return { label: "Partly done", tone: "attention" };
    case "failed":
      return { label: "Failed", tone: "attention" };
    case "reverted":
      return { label: "Rolled back", tone: "rolled-back" };
    case "archived":
      return { label: "Closed", tone: "neutral" };
    default:
      return thread.type === "conversation"
        ? { label: "Conversation", tone: "neutral" }
        : { label: "No request yet", tone: "neutral" };
  }
}

/** Threads that are waiting on the operator, most urgent first. */
export function threadsNeedingYou(
  threads: SiteActivityThread[]
): SiteActivityThread[] {
  const rank = (thread: SiteActivityThread): number => {
    if (thread.v2State === "approved") {
      return thread.approvalExpiresAt &&
        minutesUntil(thread.approvalExpiresAt) > 0
        ? 0
        : 3;
    }
    if (thread.v2State === "review_ready") return 1;
    if (thread.v2State === "stale_approval") return 2;
    if (!thread.v2State && thread.requestStatus === "clarifying") return 2;
    return -1;
  };
  return threads
    .filter((thread) => rank(thread) >= 0)
    .sort((a, b) => rank(a) - rank(b));
}

export function targetLabel(thread: SiteActivityThread): string | null {
  const target = thread.target;
  if (!target) return null;
  const kind = target.postType === "page" ? "Page" : "Post";
  if (target.operation === "create_draft") return `New ${kind.toLowerCase()} draft`;
  return `${kind} #${target.postId}`;
}

export function chatPathFor(
  siteId: string,
  thread: Pick<SiteActivityThread, "threadId" | "type">
): string {
  const page = thread.type === "conversation" ? "conversations" : "chat";
  return `/site/${siteId}/${page}?thread=${encodeURIComponent(thread.threadId)}`;
}

/** "16:30" today, "Yesterday 16:30", otherwise "28 Sep, 16:30". */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  const day = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" })
  });
  return `${day}, ${time}`;
}
