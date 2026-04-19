export type TimestampValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_iso_timestamp" | "timestamp_outside_skew";
    };

/**
 * Reject requests whose `x-sitepilot-timestamp` is outside a symmetric skew
 * window compared to `nowMs` (typically `Date.now()` in the verifier).
 */
export function validateTimestampWithinSkew(
  isoTimestamp: string,
  options: { nowMs: number; maxSkewMs: number }
): TimestampValidationResult {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return { ok: false, reason: "invalid_iso_timestamp" };
  }
  const delta = Math.abs(options.nowMs - parsed);
  if (delta > options.maxSkewMs) {
    return { ok: false, reason: "timestamp_outside_skew" };
  }
  return { ok: true };
}
