/**
 * Canonical UTF-8 string that both the desktop client and WordPress plugin must
 * derive identically before signing or verifying. Changing this format is a
 * breaking protocol change — bump `protocolVersion` together with this.
 */
export type SigningInputParts = {
  method: string;
  path: string;
  siteId: string;
  requestId: string;
  clientId: string;
  timestamp: string;
  nonce: string;
  payloadSha256Hex: string;
};

export function buildSigningInput(parts: SigningInputParts): string {
  const method = parts.method.trim().toUpperCase();
  const path = parts.path.trim();
  const lines = [
    "SITEPILOT_REQUEST_V1",
    `${method} ${path}`,
    `siteId:${parts.siteId}`,
    `requestId:${parts.requestId}`,
    `clientId:${parts.clientId}`,
    `timestamp:${parts.timestamp}`,
    `nonce:${parts.nonce}`,
    `payloadSha256:${parts.payloadSha256Hex}`
  ];
  return lines.join("\n");
}
