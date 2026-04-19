import type { SignedRequestHeaders } from "@sitepilot/contracts";

import type { SeenNonceCache } from "./nonce.js";
import { parseSignedRequestHeaders } from "./signed-request.js";
import { validateTimestampWithinSkew } from "./timing.js";

export type ValidateSignedRequestOptions = {
  headers: Record<string, string | string[] | undefined>;
  nowMs: number;
  maxSkewMs: number;
  nonceCache: SeenNonceCache;
  /** When set, must match `x-sitepilot-payload-sha256`. */
  expectedPayloadSha256Hex?: string;
};

export type ValidateSignedRequestResult =
  | { ok: true; headers: SignedRequestHeaders }
  | { ok: false; reason: string };

/**
 * Header parse + timestamp skew + nonce replay cache + optional body hash check.
 * Signature verification is separate (`verifyRequestSignature`).
 */
export function validateSignedRequest(
  options: ValidateSignedRequestOptions
): ValidateSignedRequestResult {
  const parsed = parseSignedRequestHeaders(options.headers);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_signed_headers" };
  }
  const headers = parsed.data;
  const ts = validateTimestampWithinSkew(headers["x-sitepilot-timestamp"], {
    nowMs: options.nowMs,
    maxSkewMs: options.maxSkewMs
  });
  if (!ts.ok) {
    return { ok: false, reason: ts.reason };
  }
  const nonce = options.nonceCache.checkAndRemember(
    headers["x-sitepilot-nonce"],
    options.nowMs
  );
  if (!nonce.ok) {
    return { ok: false, reason: nonce.reason };
  }
  if (options.expectedPayloadSha256Hex !== undefined) {
    if (
      options.expectedPayloadSha256Hex !== headers["x-sitepilot-payload-sha256"]
    ) {
      return { ok: false, reason: "payload_sha256_mismatch" };
    }
  }
  return { ok: true, headers };
}
