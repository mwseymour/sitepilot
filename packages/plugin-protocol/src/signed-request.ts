import { signedRequestHeadersSchema } from "@sitepilot/contracts";

import { normalizeHeaderMap } from "./headers.js";

const SIGNED_HEADER_KEYS = [
  "x-sitepilot-request-id",
  "x-sitepilot-site-id",
  "x-sitepilot-client-id",
  "x-sitepilot-timestamp",
  "x-sitepilot-nonce",
  "x-sitepilot-signature",
  "x-sitepilot-payload-sha256"
] as const;

/**
 * Parse and validate signed request headers from an HTTP header bag. Keys are
 * matched case-insensitively; field names stay aligned with
 * `signedRequestHeadersSchema` in contracts.
 */
export function parseSignedRequestHeaders(
  headers: Record<string, string | string[] | undefined>
) {
  const lower = normalizeHeaderMap(headers);
  const candidate: Record<string, string> = {};
  for (const key of SIGNED_HEADER_KEYS) {
    candidate[key] = lower[key] ?? "";
  }
  return signedRequestHeadersSchema.safeParse(candidate);
}
