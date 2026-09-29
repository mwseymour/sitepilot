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

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractBeforeAfter(value: unknown): {
  before: Record<string, unknown> | null;
  after: unknown;
} {
  const record = recordValue(value);
  return {
    before: recordValue(record?.before),
    after: record?.after ?? null
  };
}

export type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

function stringifyDiffValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

export function buildDiffLines(
  beforeValue: unknown,
  afterValue: unknown
): DiffLine[] {
  const beforeLines = stringifyDiffValue(beforeValue).split("\n");
  const afterLines = stringifyDiffValue(afterValue).split("\n");
  const lineCounts = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0)
  );

  for (
    let beforeIndex = beforeLines.length - 1;
    beforeIndex >= 0;
    beforeIndex -= 1
  ) {
    for (
      let afterIndex = afterLines.length - 1;
      afterIndex >= 0;
      afterIndex -= 1
    ) {
      lineCounts[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lineCounts[beforeIndex + 1]?.[afterIndex + 1] ?? 0) + 1
          : Math.max(
              lineCounts[beforeIndex + 1]?.[afterIndex] ?? 0,
              lineCounts[beforeIndex]?.[afterIndex + 1] ?? 0
            );
    }
  }

  const diffLines: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      diffLines.push({
        kind: "context",
        text: `  ${beforeLines[beforeIndex]}`
      });
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    const skipBeforeScore = lineCounts[beforeIndex + 1]?.[afterIndex] ?? 0;
    const skipAfterScore = lineCounts[beforeIndex]?.[afterIndex + 1] ?? 0;

    if (skipBeforeScore >= skipAfterScore) {
      diffLines.push({
        kind: "removed",
        text: `- ${beforeLines[beforeIndex]}`
      });
      beforeIndex += 1;
      continue;
    }

    diffLines.push({ kind: "added", text: `+ ${afterLines[afterIndex]}` });
    afterIndex += 1;
  }

  while (beforeIndex < beforeLines.length) {
    diffLines.push({ kind: "removed", text: `- ${beforeLines[beforeIndex]}` });
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    diffLines.push({ kind: "added", text: `+ ${afterLines[afterIndex]}` });
    afterIndex += 1;
  }

  return diffLines;
}

export function parseJsonDebugValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
