import { createHash, createHmac, randomBytes } from "node:crypto";

import { buildSigningInput } from "./signing-input.js";

/**
 * SHA-256 fingerprint of a shared secret (hex), used in registration metadata.
 */
export function fingerprintSharedSecret(secret: Buffer): string {
  return createHash("sha256").update(secret).digest("hex");
}

export type SignSitePilotHmacRequestParams = {
  method: string;
  /** URL path including leading slash, e.g. `/wp-json/sitepilot/mcp`. */
  path: string;
  siteId: string;
  clientId: string;
  bodyBuffer: Buffer;
  sharedSecret: Buffer;
  requestId?: string;
  nonce?: string;
  timestampIso?: string;
};

/**
 * Builds SitePilot HMAC request headers for outbound HTTP calls (desktop → plugin).
 */
export function signSitePilotHmacRequest(
  params: SignSitePilotHmacRequestParams
): Record<string, string> {
  const requestId = params.requestId ?? randomBytes(16).toString("hex");
  const nonce = params.nonce ?? randomBytes(16).toString("hex");
  const timestampIso = params.timestampIso ?? new Date().toISOString();
  const payloadSha256Hex = createHash("sha256")
    .update(params.bodyBuffer)
    .digest("hex");
  const signingInput = buildSigningInput({
    method: params.method,
    path: params.path,
    siteId: params.siteId,
    requestId,
    clientId: params.clientId,
    timestamp: timestampIso,
    nonce,
    payloadSha256Hex
  });
  const signatureHex = createHmac("sha256", params.sharedSecret)
    .update(signingInput, "utf8")
    .digest("hex");
  return {
    "x-sitepilot-request-id": requestId,
    "x-sitepilot-site-id": params.siteId,
    "x-sitepilot-client-id": params.clientId,
    "x-sitepilot-timestamp": timestampIso,
    "x-sitepilot-nonce": nonce,
    "x-sitepilot-signature": signatureHex,
    "x-sitepilot-payload-sha256": payloadSha256Hex
  };
}
