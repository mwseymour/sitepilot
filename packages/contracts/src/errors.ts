import { z } from "zod";

import { jsonValueSchema } from "./common.js";

/**
 * sitepilot.error/v1: one error shape for the plugin, the desktop, SitePilot's
 * MCP server and the planner. Codes are for machines; messages stay plain
 * language for people.
 */

export const errorCauseSchema = z.enum([
  "auth",
  "capability",
  "not_found",
  "invalid_input",
  "stale",
  "conflict",
  "approval_required",
  "not_supported",
  "host_environment",
  "wp_core",
  "filesystem",
  "render_failed",
  "internal"
]);
export type ErrorCause = z.infer<typeof errorCauseSchema>;

/** Why a signed request was refused. Safe to show; nothing secret-derived. */
export const authFailureReasonSchema = z.enum([
  "headers_missing",
  "invalid_signed_headers",
  "invalid_iso_timestamp",
  "timestamp_outside_skew",
  "nonce_replayed",
  "payload_sha256_mismatch",
  "unknown_site",
  "no_mapped_user",
  "client_mismatch",
  "signature_invalid"
]);
export type AuthFailureReason = z.infer<typeof authFailureReasonSchema>;

export const sitePilotErrorSchema = z.object({
  code: z.string().min(1),
  cause: errorCauseSchema,
  retryable: z.boolean(),
  message: z.string().min(1),
  details: z.record(jsonValueSchema).optional(),
  auth: z.object({ reason: authFailureReasonSchema }).optional()
});
export type SitePilotError = z.infer<typeof sitePilotErrorSchema>;

type Classification = { cause: ErrorCause; retryable: boolean };

const permanent = (cause: ErrorCause): Classification => ({ cause, retryable: false });

/**
 * Cause and retry flag for each known code. The plugin sends these itself
 * from `error_contract_v1`; this table covers older plugins and desktop codes.
 * A code that isn't listed is never treated as safe to retry.
 */
export const KNOWN_ERROR_CODES: Readonly<Record<string, Classification>> = {
  // Input the plugin or planner refused.
  schema_invalid: permanent("invalid_input"),
  request_too_large: permanent("invalid_input"),
  invalid_block_markup: permanent("invalid_input"),
  invalid_nesting: permanent("invalid_input"),
  unexpected_block: permanent("invalid_input"),
  missing_block: permanent("invalid_input"),
  fallback_block: permanent("invalid_input"),
  locked_structure: permanent("invalid_input"),
  content_loss: permanent("invalid_input"),
  invalid_session_request: permanent("invalid_input"),
  invalid_json: permanent("invalid_input"),
  invalid_payload: permanent("invalid_input"),
  invalid_environment: permanent("invalid_input"),
  invalid_secret: permanent("invalid_input"),
  invalid_wordpress_user: permanent("invalid_input"),
  wordpress_user_required: permanent("invalid_input"),
  // Blocks and features the destination can't do.
  unregistered_block: permanent("not_supported"),
  disallowed_block: permanent("not_supported"),
  unsupported_v2_block: permanent("not_supported"),
  v2_disabled: permanent("not_supported"),
  protocol_mismatch: permanent("not_supported"),
  // The post or the site changed since the candidate was built.
  stale_source: permanent("stale"),
  runtime_changed: permanent("stale"),
  // Conflicts that need a person to look.
  idempotency_conflict: permanent("conflict"),
  prepared_commit_changed: permanent("conflict"),
  rollback_conflict: permanent("conflict"),
  media_changed: permanent("conflict"),
  site_exists: permanent("conflict"),
  // WordPress changed or refused what was written.
  content_changed: permanent("wp_core"),
  persisted_content_invalid: permanent("wp_core"),
  verification_failed: permanent("wp_core"),
  // Approval.
  approval_invalid: permanent("approval_required"),
  approval_expired: permanent("approval_required"),
  // Identity and permissions.
  permission_denied: permanent("capability"),
  read_only: permanent("capability"),
  invalid_bootstrap: permanent("auth"),
  invalid_code: permanent("auth"),
  // Missing things.
  prepared_commit_missing: permanent("not_found"),
  post_not_found: permanent("not_found"),
  // Transient: safe to retry (a commit retry reconciles first).
  editor_unavailable: { cause: "host_environment", retryable: true },
  conditional_commit_failed: { cause: "internal", retryable: true },
  // The saved post no longer renders.
  render_failed: permanent("render_failed"),
  // Never retry blindly: the site may be half-changed.
  rollback_failed: permanent("internal"),
  // A WordPress refusal with a code SitePilot doesn't know.
  wordpress_error: permanent("internal"),
  // SitePilot's own MCP server and desktop request flow.
  forbidden: permanent("capability"),
  no_sites: permanent("not_found"),
  site_not_found: permanent("not_found"),
  site_not_active: permanent("not_found"),
  request_not_found: permanent("not_found"),
  thread_not_found: permanent("not_found"),
  artifact_not_found: permanent("not_found"),
  candidate_not_found: permanent("not_found"),
  discovery_missing: permanent("not_found"),
  site_required: permanent("invalid_input"),
  post_id_required: permanent("invalid_input"),
  not_a_request: permanent("invalid_input"),
  not_a_conversation: permanent("invalid_input"),
  request_empty: permanent("invalid_input"),
  target_mismatch: permanent("invalid_input"),
  thread_site_mismatch: permanent("invalid_input"),
  planner_not_configured: permanent("host_environment"),
  request_engine_conflict: permanent("conflict"),
  execution_complete: permanent("conflict"),
  // Busy: the same call can work once the current step finishes.
  request_busy: { cause: "conflict", retryable: true },
  request_in_progress: { cause: "conflict", retryable: true },
  generation_in_progress: { cause: "conflict", retryable: true },
  execution_in_progress: { cause: "conflict", retryable: true },
  planner_model_failed: { cause: "host_environment", retryable: true },
  lookup_failed: permanent("internal"),
  internal_error: permanent("internal")
};

/** Classifies a code, with a safe default for codes nobody listed. */
export function classifyErrorCode(code: string): Classification {
  const normalized = code.replace(/^sitepilot_(v2_)?/, "");
  return KNOWN_ERROR_CODES[normalized] ?? permanent("internal");
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads a WordPress REST error body into sitepilot.error/v1. Plugins with
 * error_contract_v1 send the cause and retry flag in `data`; for older ones
 * they come from the code. An unknown code is retryable only for a 5xx.
 */
export function parseWordPressError(
  httpStatus: number,
  body: unknown,
  fallbackMessage = `WordPress returned HTTP ${httpStatus}.`
): SitePilotError & { httpStatus: number } {
  const record = recordOf(body);
  const data = recordOf(record.data);
  const code =
    typeof data.code === "string" && data.code.length > 0
      ? data.code
      : typeof record.code === "string" && record.code.length > 0
        ? record.code.replace(/^sitepilot_(v2_)?/, "")
        : `http_${httpStatus}`;
  const known = Object.hasOwn(KNOWN_ERROR_CODES, code);
  const classification = classifyErrorCode(code);
  const sentCause = errorCauseSchema.safeParse(data.cause);
  const sentReason = authFailureReasonSchema.safeParse(recordOf(data.auth).reason);
  const details = recordOf(data.details);
  const parsedDetails = z.record(jsonValueSchema).safeParse(details);
  return {
    code,
    cause: sentCause.success
      ? sentCause.data
      : known
        ? classification.cause
        : httpStatus === 401
          ? "auth"
          : httpStatus === 403
            ? "capability"
            : "internal",
    retryable:
      typeof data.retry_ok === "boolean"
        ? data.retry_ok
        : known
          ? classification.retryable
          : httpStatus >= 500,
    message:
      typeof record.message === "string" && record.message.trim().length > 0
        ? record.message.trim().slice(0, 2_000)
        : fallbackMessage,
    ...(parsedDetails.success && Object.keys(parsedDetails.data).length > 0
      ? { details: parsedDetails.data }
      : {}),
    ...(sentReason.success ? { auth: { reason: sentReason.data } } : {}),
    httpStatus
  };
}
