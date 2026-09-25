import {
  GUTENBERG_V2_SEO_FIELDS,
  GUTENBERG_V2_SEO_FIELD_LABELS,
  type GutenbergV2CompiledCandidate,
  type GutenbergV2ExecutionResult,
  type GutenbergV2JobRecord,
  type GutenbergV2ValidationIssue
} from "@sitepilot/contracts";

/**
 * Operator-facing lifecycle reports for Gutenberg v2. These messages are the
 * thread's record of what happened, so they carry the full reason, target and
 * identifiers an admin needs to act without opening diagnostics (the same
 * text is what a Slack adapter relays).
 */

export type GutenbergV2ReportTarget =
  | { operation: "create_draft"; postType: "post" | "page" }
  | {
      operation: "replace_content" | "apply_operations";
      postType: "post" | "page";
      postId: number;
    }
  | {
      operation: "set_status";
      postType: "post" | "page";
      postId: number;
      status: "publish" | "draft";
    };

const MAX_LISTED_ISSUES = 10;
const MAX_MARKUP = 300;

function targetLabel(target: GutenbergV2ReportTarget): string {
  if (target.operation === "create_draft") {
    return `new ${target.postType} draft`;
  }
  const verb =
    target.operation === "set_status"
      ? target.status === "publish"
        ? "publish"
        : "unpublish"
      : target.operation === "replace_content"
        ? "replace all content of"
        : "scoped changes to";
  return `${verb} ${target.postType} #${target.postId}`;
}

function blockPosition(path: readonly number[] | undefined): string | null {
  return path === undefined || path.length === 0
    ? null
    : `position ${path.map((index) => index + 1).join(" › ")}`;
}

function clip(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_MARKUP
    ? `${compact.slice(0, MAX_MARKUP)}…`
    : compact;
}

function seoLines(candidate: GutenbergV2CompiledCandidate): string[] {
  const seo = candidate.requestedPostFields.seo;
  if (seo === undefined) return [];
  return GUTENBERG_V2_SEO_FIELDS.flatMap((field) => {
    const value = seo[field];
    return value === undefined
      ? []
      : [
          `${GUTENBERG_V2_SEO_FIELD_LABELS[field]}: ${value === "" ? "cleared (plugin default)" : clip(value)}`
        ];
  });
}

export function formatGutenbergV2Issue(
  issue: GutenbergV2ValidationIssue
): string {
  const where = [
    issue.blockName,
    blockPosition(issue.blockPath),
    issue.planRef === undefined ? null : `plan ref "${issue.planRef}"`
  ].filter((part): part is string => part !== null && part !== undefined);
  const lines = [
    `• [${issue.code}, ${issue.phase}] ${issue.message}${
      where.length > 0 ? ` (${where.join(", ")})` : ""
    }`
  ];
  if (issue.expected !== undefined) {
    lines.push(`  expected: ${clip(issue.expected)}`);
  }
  if (issue.actual !== undefined) {
    lines.push(`  actual: ${clip(issue.actual)}`);
  }
  return lines.join("\n");
}

function issueList(issues: readonly GutenbergV2ValidationIssue[]): string[] {
  const listed = issues.slice(0, MAX_LISTED_ISSUES).map(formatGutenbergV2Issue);
  if (issues.length > MAX_LISTED_ISSUES) {
    listed.push(`• …and ${issues.length - MAX_LISTED_ISSUES} more issues`);
  }
  return listed;
}

function countBlocks(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce<number>((total, node) => {
    const children =
      node !== null && typeof node === "object"
        ? (node as { children?: unknown }).children
        : undefined;
    return total + 1 + countBlocks(children);
  }, 0);
}

function featuredImageLabel(
  candidate: GutenbergV2CompiledCandidate
): string | null {
  const ref = candidate.requestedPostFields.featuredMediaRef;
  if (ref === undefined) return null;
  return candidate.intent.media.find((item) => item.ref === ref)?.alt ?? ref;
}

function changeSummary(candidate: GutenbergV2CompiledCandidate): string {
  if (candidate.intent.operation === "set_status") {
    return "unchanged (status change only)";
  }
  const intent = candidate.intent as {
    blocks?: unknown;
    operations?: Array<{ type?: string }>;
  };
  if (Array.isArray(intent.operations) && intent.operations.length === 0) {
    return "no content changes";
  }
  if (Array.isArray(intent.operations)) {
    const counts = new Map<string, number>();
    for (const operation of intent.operations) {
      const type = operation.type ?? "change";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const labels: Record<string, string> = {
      insert_blocks: "insertion",
      edit_block: "block edit",
      remove_block: "block removal",
      move_block: "block move"
    };
    return [...counts]
      .map(([type, count]) => {
        const label = labels[type] ?? type;
        return `${count} ${label}${count === 1 ? "" : "s"}`;
      })
      .join(", ");
  }
  return `${countBlocks(intent.blocks)} blocks`;
}

export function candidateReadyReport(input: {
  target: GutenbergV2ReportTarget;
  candidate: GutenbergV2CompiledCandidate;
  executionId: string;
  revisionNote?: string;
  notices?: readonly string[];
}): string {
  const { candidate } = input;
  const title = candidate.requestedPostFields.title;
  const lines = [
    `Gutenberg v2 candidate ready for review: ${targetLabel(input.target)}.`,
    ...(title === undefined ? [] : [`Title: ${title}`]),
    ...(featuredImageLabel(candidate) === null
      ? []
      : [
          `Featured image: ${featuredImageLabel(candidate)} (${candidate.requestedPostFields.featuredMediaRef})`
        ]),
    ...seoLines(candidate),
    `Content: ${changeSummary(candidate)}; destination editor validation ${candidate.validation.outcome} (${candidate.validation.observedBlockCount}/${candidate.validation.expectedBlockCount} blocks).`,
    ...(input.revisionNote === undefined
      ? []
      : [`Revision applied: ${clip(input.revisionNote)}`]),
    ...(input.notices ?? []).map((notice) => `Note: ${notice}`),
    `Candidate ${candidate.candidateId} · execution ${input.executionId}.`,
    "Next: review the structure and previews, then approve, or reply in this thread to change it."
  ];
  if (candidate.validation.issues.length > 0) {
    lines.push("Warnings:", ...issueList(candidate.validation.issues));
  }
  return lines.join("\n");
}

export function decisionReport(input: {
  decision: "approved" | "rejected" | "revision_requested" | "withdrawn";
  target: GutenbergV2ReportTarget;
  candidateId: string;
  approverId: string;
  note?: string;
  expiresAt?: string;
}): string {
  const note =
    input.note === undefined || input.note.trim().length === 0
      ? null
      : clip(input.note);
  switch (input.decision) {
    case "approved":
      return [
        `Gutenberg v2 candidate approved by ${input.approverId}: ${targetLabel(input.target)}.`,
        `Candidate ${input.candidateId}${
          input.expiresAt === undefined
            ? ""
            : `; approval expires ${input.expiresAt}`
        }.`,
        "Next: apply the update. Nothing is written until then."
      ].join("\n");
    case "withdrawn":
      return [
        `Approval withdrawn for candidate ${input.candidateId} (${targetLabel(input.target)}) because a change was requested before it was applied.`,
        ...(note === null ? [] : [`Requested change: ${note}`]),
        "Nothing was written. A revised candidate is being prepared."
      ].join("\n");
    case "revision_requested":
      return [
        `Revision requested for candidate ${input.candidateId} by ${input.approverId} (${targetLabel(input.target)}).`,
        ...(note === null ? [] : [`Requested change: ${note}`]),
        "Nothing was written. The candidate is superseded by the revision."
      ].join("\n");
    case "rejected":
      return [
        `Gutenberg v2 candidate rejected by ${input.approverId}: ${targetLabel(input.target)}.`,
        `Candidate ${input.candidateId}.`,
        `Reason: ${note ?? "no reason was given."}`,
        "Nothing was written. Reply in this thread to request a new candidate, or start a new request."
      ].join("\n");
  }
}

const EXECUTION_STATE_LABELS: Record<string, string> = {
  succeeded: "completed and verified",
  post_write_verification_failed:
    "written, but the saved content failed verification",
  rolled_back: "written, failed verification, and was rolled back",
  rollback_conflict:
    "written, failed verification, and could not be rolled back because the post changed since",
  manual_intervention_required: "needs manual intervention",
  pre_write_failed: "stopped before anything was written",
  stale_approval: "stopped before anything was written: the approval is stale"
};

export function executionReport(input: {
  target: GutenbergV2ReportTarget;
  result: GutenbergV2ExecutionResult;
  job?: GutenbergV2JobRecord | null;
}): string {
  const { result } = input;
  const lines = [
    `Gutenberg v2 execution ${EXECUTION_STATE_LABELS[result.state] ?? result.state}: ${targetLabel(input.target)}.`
  ];
  if (result.postId !== undefined) {
    lines.push(
      `Post #${result.postId}${
        result.persistedRevision === undefined
          ? ""
          : `, revision ${result.persistedRevision}`
      }.`
    );
  }
  if (result.verification) {
    const verification = result.verification;
    lines.push(
      `Verification: ${verification.outcome} (${verification.observedBlockCount}/${verification.expectedBlockCount} blocks); content preservation ${
        verification.contentPreservation.passed ? "passed" : "failed"
      } for ${verification.contentPreservation.checked.join(", ")}.`
    );
  }
  if (result.createdMediaIds.length > 0) {
    lines.push(`Media created: ${result.createdMediaIds.join(", ")}.`);
  }
  if (result.rollback.attempted) {
    lines.push(`Rollback: ${result.rollback.outcome}.`);
  }
  const issues = [
    ...(input.job?.failure ? [input.job.failure] : []),
    ...(result.verification?.issues ?? [])
  ];
  if (issues.length > 0) {
    lines.push("Issues:", ...issueList(issues));
  }
  if (result.state !== "succeeded") {
    lines.push(
      result.retry.retryable
        ? "Next: this can be retried safely from the request panel."
        : "Next: inspect the post in WordPress before retrying; do not re-run blindly."
    );
  }
  lines.push(`Execution ${result.executionId} · audit ${result.auditRef}.`);
  return lines.join("\n");
}

type ReportableError = {
  message: string;
  code?: string;
  retryable?: boolean;
  issues?: readonly (GutenbergV2ValidationIssue | string)[];
};

export function failureReport(input: {
  stage: "generation" | "approval" | "execution";
  target: GutenbergV2ReportTarget;
  executionId: string;
  error: ReportableError;
  notices?: readonly string[];
}): string {
  const stageLabel = {
    generation: "Gutenberg v2 candidate could not be generated",
    approval: "Gutenberg v2 decision could not be recorded",
    execution: "Gutenberg v2 execution failed"
  }[input.stage];
  const issues = input.error.issues ?? [];
  const lines = [
    `${stageLabel}: ${targetLabel(input.target)}.`,
    `Reason${input.error.code === undefined ? "" : ` (${input.error.code})`}: ${input.error.message}`,
    ...(input.notices ?? []).map((notice) => `Note: ${notice}`)
  ];
  if (issues.length > 0) {
    lines.push(
      "Details:",
      ...issues
        .slice(0, MAX_LISTED_ISSUES)
        .map((issue) =>
          typeof issue === "string"
            ? `• ${issue}`
            : formatGutenbergV2Issue(issue)
        )
    );
    if (issues.length > MAX_LISTED_ISSUES) {
      lines.push(`• …and ${issues.length - MAX_LISTED_ISSUES} more issues`);
    }
  }
  lines.push(
    input.stage === "execution"
      ? input.error.retryable
        ? "Nothing was confirmed as written. This can be retried safely."
        : "Check the post in WordPress before retrying."
      : "Nothing was written. Reply in this thread to adjust the request and try again."
  );
  lines.push(`Execution ${input.executionId}.`);
  return lines.join("\n");
}

const ATTACHMENT_REFERENCE =
  /\b(attached|attachment|uploaded)\s+(image|images|photo|photos|picture|pictures|file|files|media)\b|\b(first|second|third|this|these|the)\s+(attached|uploaded)\b/i;

/** Plain-language warnings about the request an admin should see. */
export function requestNotices(input: {
  prompt: string;
  attachmentCount: number;
  referenceCount?: number;
  failed?: boolean;
}): string[] {
  if ((input.referenceCount ?? 0) > 0 && input.attachmentCount === 0) {
    return [
      "The attached layout reference was used to build the content. Pictures shown inside it are not added to the post; attach them separately as images if you want them placed."
    ];
  }
  if (input.attachmentCount > 0 || !ATTACHMENT_REFERENCE.test(input.prompt)) {
    return [];
  }
  return [
    input.failed
      ? "The request refers to attached images, but no images were attached. Attach the images and reply in this thread to try again."
      : "The request refers to attached images, but no images were attached, so image blocks were left out (text from media-and-text blocks was kept). Attach the images and reply in this thread to add them."
  ];
}

// ---------------------------------------------------------------------------
// Plain-language versions. `value` on a chat message is what people (and the
// Slack adapter) read; the technical reports above travel alongside as
// `technicalDetails` for the in-app "technical details" toggle.

function contentNoun(target: GutenbergV2ReportTarget): string {
  return target.postType === "page" ? "page" : "post";
}

function capitalised(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function subject(target: GutenbergV2ReportTarget): string {
  return target.operation === "create_draft"
    ? `the new ${contentNoun(target)}`
    : `${contentNoun(target)} #${target.postId}`;
}

/**
 * The approval card for a status change says exactly what will happen and
 * where, since approving it changes what the public sees.
 */
function statusChangeReady(input: {
  target: Extract<GutenbergV2ReportTarget, { operation: "set_status" }>;
  title?: string;
  publicUrl?: string;
}): string {
  const which = `${contentNoun(input.target)} #${input.target.postId}${
    input.title ? ` “${input.title}”` : ""
  }`;
  const where = input.publicUrl ?? "its URL";
  return input.target.status === "publish"
    ? `Ready to publish ${which}. Once you approve and apply it, it will be live at ${where}. Only the status changes; the content stays as it is.`
    : `Ready to unpublish ${which}. Once you approve and apply it, it goes back to being a draft and ${where} will stop loading for visitors.`;
}

export function friendlyCandidateReady(input: {
  target: GutenbergV2ReportTarget;
  candidate: GutenbergV2CompiledCandidate;
  notices?: readonly string[];
  /** For a status change: the post's title and public URL. */
  status?: { title?: string; publicUrl?: string };
}): string {
  if (input.target.operation === "set_status") {
    return [
      statusChangeReady({ target: input.target, ...input.status }),
      "Approve it, or reject it to leave the post as it is. Nothing changes until you approve and apply it.",
      ...(input.notices ?? [])
    ].join(" ");
  }
  const title = input.candidate.requestedPostFields.title;
  const featured = featuredImageLabel(input.candidate);
  const what =
    input.target.operation === "create_draft"
      ? `A draft ${contentNoun(input.target)}${title ? ` “${title}”` : ""} is ready to review.`
      : `Your changes to ${subject(input.target)}${title ? ` (“${title}”)` : ""} are ready to review.`;
  return [
    what,
    ...(featured === null
      ? []
      : [`It sets the featured image to “${featured}”.`]),
    ...(input.candidate.requestedPostFields.seo === undefined
      ? []
      : [
          `It changes the ${GUTENBERG_V2_SEO_FIELDS.filter(
            (field) =>
              input.candidate.requestedPostFields.seo?.[field] !== undefined
          )
            .map((field) => GUTENBERG_V2_SEO_FIELD_LABELS[field].toLowerCase())
            .join(", ")}.`
        ]),
    "Check the preview, then approve it, or reply here with anything you want changed. Nothing is saved until you approve and apply it.",
    ...(input.notices ?? [])
  ].join(" ");
}

export function friendlyDecision(input: {
  decision: "approved" | "rejected" | "revision_requested" | "withdrawn";
  target: GutenbergV2ReportTarget;
  note?: string;
}): string {
  const note =
    input.note === undefined || input.note.trim().length === 0
      ? null
      : clip(input.note);
  switch (input.decision) {
    case "approved":
      return `Approved. Apply the update when you're ready; nothing on the site changes until then.`;
    case "rejected":
      return `Rejected${note === null ? "" : `: ${note}`}. Nothing on the site was changed.`;
    case "revision_requested":
      return `Changes requested${note === null ? "" : `: ${note}`}. A revised version is being prepared; nothing on the site was changed.`;
    case "withdrawn":
      return `The approval was withdrawn because you asked for another change. A revised version is being prepared; nothing on the site was changed.`;
  }
}

export function friendlyExecution(input: {
  target: GutenbergV2ReportTarget;
  result: GutenbergV2ExecutionResult;
}): string {
  const where =
    input.result.postId !== undefined
      ? `${contentNoun(input.target)} #${input.result.postId}`
      : subject(input.target);
  if (input.target.operation === "set_status") {
    const publish = input.target.status === "publish";
    switch (input.result.state) {
      case "succeeded":
        return publish
          ? `Done. ${capitalised(where)} is published, and SitePilot checked that it loads for visitors.`
          : `Done. ${capitalised(where)} is back to a draft, and SitePilot checked that it no longer loads for visitors.`;
      case "rolled_back":
        return publish
          ? `${capitalised(where)} was published but didn't load for visitors, so SitePilot put it back to a draft. Please check it in WordPress.`
          : `${capitalised(where)} was unpublished but still loaded for visitors, so SitePilot put it back to published. Please check it in WordPress.`;
      case "rollback_conflict":
        return `The status change to ${where} didn't pass the final check, and someone has edited it since, so SitePilot left it as it is. Please check it in WordPress.`;
      default:
        return `The status change to ${where} didn't finish cleanly. Please check it in WordPress before trying again.`;
    }
  }
  switch (input.result.state) {
    case "succeeded":
      return input.target.operation === "create_draft"
        ? `Done. The draft has been saved as ${where} and checked in WordPress.`
        : `Done. ${where[0]!.toUpperCase()}${where.slice(1)} has been updated and checked in WordPress.`;
    case "rolled_back":
      return `The update to ${where} was saved but didn't pass the final check, so SitePilot put the previous version back. Please review it in WordPress.`;
    case "rollback_conflict":
      return `The update to ${where} didn't pass the final check, and someone has edited it since, so SitePilot left it as it is. Please check it in WordPress.`;
    default:
      return `The update to ${where} didn't finish cleanly. Please check it in WordPress before trying again.`;
  }
}

export function friendlyFailureFallback(input: {
  stage: "generation" | "approval" | "execution";
  target: GutenbergV2ReportTarget;
  notices?: readonly string[];
}): string {
  const lead = {
    generation: `SitePilot couldn't build this update for ${subject(input.target)}. Nothing on the site was changed.`,
    approval: `SitePilot couldn't record that decision. Nothing on the site was changed.`,
    execution: `SitePilot couldn't finish applying the update to ${subject(input.target)}. Please check it in WordPress before trying again.`
  }[input.stage];
  return [
    lead,
    ...(input.notices ?? []),
    input.stage === "execution"
      ? ""
      : "Reply here with more detail and SitePilot will try again."
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

const PLAIN_LANGUAGE_MAX = 600;

/** Prompt asking the model to explain a technical report for non-developers. */
export function plainLanguagePrompt(technical: string): string {
  return `Rewrite this SitePilot report for a non-technical website editor who manages a WordPress site.
Say in 2-4 short sentences: what went wrong, whether anything on the website changed, and what they should do next.
Use plain words. Do not include error codes, IDs, block paths, JSON or developer terms such as "schema", "attributes", "planner" or "mediaRef". Refer to blocks by what they are (image, table, heading).
Respond as JSON: {"message": "..."}

Report:
${technical.slice(0, 8_000)}`;
}

export function parsePlainLanguage(text: string): string | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { message?: unknown };
    if (typeof parsed.message !== "string") return null;
    const message = parsed.message.replace(/\s+/g, " ").trim();
    if (message.length === 0) return null;
    return message.length > PLAIN_LANGUAGE_MAX
      ? `${message.slice(0, PLAIN_LANGUAGE_MAX - 1)}…`
      : message;
  } catch {
    return null;
  }
}
