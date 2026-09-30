import {
  gutenbergV2ValidationFailureCodeSchema,
  parseWordPressError,
  type GutenbergV2ValidationIssue
} from "@sitepilot/contracts";

export class GutenbergV2WorkerError extends Error {
  public readonly code: GutenbergV2ValidationIssue["code"];
  public readonly retryable: boolean;
  public readonly issues: readonly GutenbergV2ValidationIssue[];
  /** The HTTP status WordPress answered with, when there was a response. */
  public readonly httpStatus: number | undefined;

  public constructor(
    code: GutenbergV2ValidationIssue["code"],
    message: string,
    retryable: boolean,
    cause?: unknown,
    issues: readonly GutenbergV2ValidationIssue[] = [],
    httpStatus?: number
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GutenbergV2WorkerError";
    this.code = code;
    this.retryable = retryable;
    this.issues = issues;
    this.httpStatus = httpStatus;
  }
}

/**
 * A worker error for a WordPress error response, the same way for every
 * client. Known codes keep their meaning; an unknown one is a retryable
 * editor_unavailable for a 5xx and a permanent wordpress_error otherwise.
 */
export function workerErrorFromWordPress(
  httpStatus: number,
  body: unknown,
  fallbackMessage: string,
  options: { authStatusMeansPermissionDenied?: boolean } = {}
): GutenbergV2WorkerError {
  const parsed = parseWordPressError(httpStatus, body, fallbackMessage);
  const aliased = parsed.code === "prepared_commit_changed" ? "idempotency_conflict" : parsed.code;
  const known = gutenbergV2ValidationFailureCodeSchema.safeParse(aliased);
  const authStatus = httpStatus === 401 || httpStatus === 403;
  const code: GutenbergV2ValidationIssue["code"] = known.success
    ? known.data
    : options.authStatusMeansPermissionDenied && authStatus
      ? "permission_denied"
      : httpStatus >= 500
        ? "editor_unavailable"
        : "wordpress_error";
  return new GutenbergV2WorkerError(
    code,
    parsed.message,
    known.success ? parsed.retryable : code === "editor_unavailable",
    undefined,
    [],
    httpStatus
  );
}
