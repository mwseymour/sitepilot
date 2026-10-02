/**
 * A review's structure artifact as plain text, for the signed link that chat
 * apps get: what the request does, then the post's block markup before and
 * after, as a line diff ("-" removed, "+" added).
 */

const MAX_LINES = 4_000;
const CONTEXT = 3;

type Structure = {
  operation?: string;
  before?: { postId?: number; fields?: { title?: string }; rawContent?: string } | null;
  after?: { plan?: { postFields?: { title?: string } }; serializedContent?: string };
};

/** Block markup split so each block comment starts a line. */
function lines(markup: string): string[] {
  return markup
    .replace(/(<!--\s*\/?wp:)/g, "\n$1")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

/** A line diff by longest common subsequence, with a few lines of context around each change. */
export function lineDiff(before: string[], after: string[]): string[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        before[i] === after[j]
          ? (table[(i + 1) * columns + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * columns + j] ?? 0, table[i * columns + j + 1] ?? 0);
    }
  }
  const out: Array<{ mark: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push({ mark: " ", text: before[i]! });
      i += 1;
      j += 1;
    } else if (i < before.length && (j === after.length || (table[(i + 1) * columns + j] ?? 0) >= (table[i * columns + j + 1] ?? 0))) {
      // Removals before additions, as unified diffs show them.
      out.push({ mark: "-", text: before[i]! });
      i += 1;
    } else {
      out.push({ mark: "+", text: after[j]! });
      j += 1;
    }
  }
  // Keep unchanged lines only near a change.
  const keep = out.map((line, index) =>
    line.mark !== " " || out.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((near) => near.mark !== " ")
  );
  const shown: string[] = [];
  out.forEach((line, index) => {
    if (keep[index]) shown.push(`${line.mark} ${line.text}`);
    else if (keep[index - 1] || index === 0) shown.push("  …");
  });
  return shown;
}

export function structureDiffText(json: string, requestTitle?: string): string {
  let structure: Structure;
  try {
    structure = JSON.parse(json) as Structure;
  } catch {
    return "This review's structure couldn't be read.";
  }
  const before = structure.before ?? null;
  const beforeTitle = before?.fields?.title;
  const afterTitle = structure.after?.plan?.postFields?.title;
  const header = [
    `SitePilot review${requestTitle ? `: ${requestTitle}` : ""}`,
    before?.postId ? `Changes to post ${before.postId} (${structure.operation ?? "edit"}).` : "A new draft.",
    ...(afterTitle !== undefined && afterTitle !== beforeTitle ? [`Title: ${beforeTitle ? `“${beforeTitle}” → ` : ""}“${afterTitle}”`] : []),
    "",
    'Block markup, "-" removed and "+" added:',
    ""
  ];
  const oldLines = lines(before?.rawContent ?? "");
  const newLines = lines(structure.after?.serializedContent ?? "");
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return [...header, "(Too long to compare here: the new content follows.)", "", ...newLines].join("\n");
  }
  const diff = lineDiff(oldLines, newLines);
  return [...header, ...(diff.length > 0 ? diff : ["(No change to the content.)"])].join("\n") + "\n";
}
