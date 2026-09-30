import type { RequestBundleOk } from "./types.js";

export type ComposerCopy = {
  title: string;
  helper: string;
  placeholder: string;
  actionLabel: string;
};

export function composerCopy({
  isConversationMode,
  bundle
}: {
  isConversationMode: boolean;
  bundle: RequestBundleOk | null;
}): ComposerCopy {
  if (isConversationMode) {
    return {
      title: "Conversation",
      helper:
        "Read-only. Conversations never change the site.",
      placeholder:
        "Ask about site content, or paste a link and ask to use it in a new Request…",
      actionLabel: "Send"
    };
  }

  if (!bundle) {
    return {
      title: "New request",
      helper: "Nothing is saved until you approve.",
      placeholder: "Ask SitePilot to create, edit, or analyse something…",
      actionLabel: "Send"
    };
  }

  switch (bundle.request.status) {
    case "clarifying":
      return {
        title: "Answer question",
        helper:
          "Your answer keeps the same request moving.",
        placeholder: "Answer the assistant's question…",
        actionLabel: "Reply"
      };
    case "new":
    case "drafted":
      return {
        title: "Refine request",
        helper: "Replying rebuilds the update for review.",
        placeholder: "Add more detail to the current request…",
        actionLabel: "Update request"
      };
    case "awaiting_approval":
      return {
        title: "Change this request",
        helper:
          "Replying rebuilds the update for review.",
        placeholder: "Describe the change, and attach images if you need to…",
        actionLabel: "Update request"
      };
    case "approved":
      return {
        title: "Change this request",
        helper: "Replying withdraws the approval.",
        placeholder: "Describe how this request should change…",
        actionLabel: "Update request"
      };
    case "executing":
      return {
        title: "Add note",
        helper:
          "SitePilot reads notes once this run finishes.",
        placeholder: "Add a note for this request…",
        actionLabel: "Add note"
      };
    default:
      return {
        title: "New request",
        helper:
          "The last request is closed. Sending starts a new one.",
        placeholder: "Ask SitePilot to do the next thing…",
        actionLabel: "Send"
      };
  }
}
