import type { GutenbergV2ValidationIssue } from "@sitepilot/contracts";

export class GutenbergV2WorkerError extends Error {
  public readonly code: GutenbergV2ValidationIssue["code"];
  public readonly retryable: boolean;
  public readonly issues: readonly GutenbergV2ValidationIssue[];

  public constructor(
    code: GutenbergV2ValidationIssue["code"],
    message: string,
    retryable: boolean,
    cause?: unknown,
    issues: readonly GutenbergV2ValidationIssue[] = []
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GutenbergV2WorkerError";
    this.code = code;
    this.retryable = retryable;
    this.issues = issues;
  }
}
