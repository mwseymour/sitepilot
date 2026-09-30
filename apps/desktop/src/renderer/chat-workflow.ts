export type ChatMode = "request" | "conversation";

const HUMAN_STATUS: Record<string, string> = {
  clarifying: "Waiting for your answer",
  new: "Ready to build",
  drafted: "Ready to build",
  awaiting_approval: "Needs approval",
  approved: "Ready to apply",
  executing: "Running on the site",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled"
};

export function humanRequestStatus(status: string): string {
  if (status in HUMAN_STATUS) {
    return HUMAN_STATUS[status]!;
  }
  return status
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function modePageCopy(mode: ChatMode): {
  navHint: string;
  pageLede: string;
  emptyState: string;
  otherModeLabel: string;
  otherModePathSegment: "chat" | "conversations";
} {
  if (mode === "conversation") {
    return {
      navHint: "Research only",
      pageLede:
        "Conversations are research-only. They do not generate plans or change the site. Start a Request when you want something applied.",
      emptyState:
        "Start a conversation to look up content or gather source material. When you are ready to change the site, open Requests.",
      otherModeLabel: "Open Requests",
      otherModePathSegment: "chat"
    };
  }
  return {
    navHint: "Make site changes",
    pageLede:
      "A request builds the change in this site’s WordPress editor for you to review, approve and apply. Use Conversations only when you need to look something up first.",
    emptyState:
      "Create a request and describe the change. You review a preview before anything is saved. Conversations will not change the site.",
    otherModeLabel: "Open Conversations",
    otherModePathSegment: "conversations"
  };
}
