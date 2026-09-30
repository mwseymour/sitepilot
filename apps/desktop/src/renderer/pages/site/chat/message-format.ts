import type { MessageRow, ThreadTypeMeta } from "./types.js";

const THREAD_TYPE_META: Record<string, ThreadTypeMeta> = {
  conversation: {
    label: "Conversation",
    description:
      "Research and read-only chat. Use it for site lookups or external source intake before creating a Request."
  },
  general_request: {
    label: "Content request",
    description:
      "Built in this site’s WordPress editor, reviewed, then applied after approval."
  },
  content_creation: {
    label: "Content creation",
    description: "Create new draft content."
  },
  content_update: {
    label: "Content update",
    description: "Revise existing posts or pages."
  },
  media_request: {
    label: "Media request",
    description: "Image and media-related changes."
  },
  seo_request: {
    label: "SEO request",
    description: "SEO metadata and search visibility changes."
  },
  taxonomy_request: {
    label: "Taxonomy request",
    description: "Category, tag, and taxonomy changes."
  },
  publish_request: {
    label: "Publish request",
    description: "Publishing and go-live tasks."
  },
  maintenance_diagnostic: {
    label: "Maintenance diagnostic",
    description: "Read-only inspection or maintenance work."
  },
  approval_discussion: {
    label: "Approval discussion",
    description: "Approval-related review and discussion."
  }
};

export function roleLabel(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant" ? "Assistant" : "System";
  }
  return "You";
}

export function isSystemMessage(message: MessageRow): boolean {
  return (
    typeof message.author === "object" &&
    message.author !== null &&
    "kind" in message.author &&
    message.author.kind === "system"
  );
}

export function roleClassName(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant"
      ? "chat-msg-assistant"
      : "chat-msg-system";
  }
  return "chat-msg-user";
}

export function roleIcon(m: MessageRow): string {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant" ? "AI" : "SYS";
  }
  return "YOU";
}

export function clarificationLines(message: MessageRow): {
  intro: string[];
  questionLabel?: string;
  questions: string[];
} | null {
  if (
    typeof message.author !== "object" ||
    message.author === null ||
    !("kind" in message.author) ||
    message.author.kind !== "assistant"
  ) {
    return null;
  }

  const lines = message.body.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const directLead = lines[0] ?? "";
  if (
    directLead === "More detail is needed before planning:" ||
    directLead === "Thanks. I still need a bit more detail:"
  ) {
    const questions = lines.filter((line) => /^\d+\.\s/.test(line));
    return questions.length > 0 ? { intro: [directLead], questions } : null;
  }

  const questionLabelIndex = lines.findIndex(
    (line) => line === "Questions to answer:"
  );
  if (questionLabelIndex === -1) {
    return null;
  }

  const postQuestionLines = lines.slice(questionLabelIndex + 1);
  const nextSectionIndex = postQuestionLines.findIndex((line) =>
    /^[A-Za-z][A-Za-z\s]+:\s*$/.test(line)
  );
  const questionLines =
    nextSectionIndex === -1
      ? postQuestionLines
      : postQuestionLines.slice(0, nextSectionIndex);
  const questions = questionLines.filter((line) => /^\d+\.\s/.test(line));

  return questions.length > 0
    ? {
        intro: lines.slice(0, questionLabelIndex),
        questionLabel: "Questions to answer:",
        questions
      }
    : null;
}

export function threadTypeMeta(type: string | undefined): ThreadTypeMeta {
  if (type && type in THREAD_TYPE_META) {
    const meta = THREAD_TYPE_META[type as keyof typeof THREAD_TYPE_META];
    if (meta) {
      return meta;
    }
  }
  return {
    label: "Request",
    description: "Request thread."
  };
}
