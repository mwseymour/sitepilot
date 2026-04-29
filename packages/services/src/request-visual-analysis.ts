import type {
  ImageAttachmentPayload,
  RequestVisualAnalysisPayload
} from "@sitepilot/contracts";

const VISUAL_ANALYSIS_KEYWORDS =
  /\b(screenshot|mockup|wireframe|design|reference|layout|recreate|match this|as close to this|build from this|based on this)\b/i;

export function requestNeedsVisualAnalysisReview(input: {
  userPrompt: string;
  attachments: ImageAttachmentPayload[] | undefined;
}): boolean {
  return (
    (input.attachments?.length ?? 0) > 0 &&
    VISUAL_ANALYSIS_KEYWORDS.test(input.userPrompt)
  );
}

export function requestVisualAnalysisIsCurrent(
  requestUpdatedAt: string,
  analysis: Pick<
    RequestVisualAnalysisPayload,
    "analyzedRequestUpdatedAt" | "reviewedAt"
  > | null
): boolean {
  if (!analysis) {
    return false;
  }

  return (
    analysis.reviewedAt !== undefined &&
    analysis.analyzedRequestUpdatedAt >= requestUpdatedAt
  );
}
