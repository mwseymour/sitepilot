export const PLUGIN_PROTOCOL_PACKAGE_NAME = "@sitepilot/plugin-protocol";

export { parseSiteRegistration } from "./registration.js";
export { normalizeHeaderMap } from "./headers.js";
export { SeenNonceCache } from "./nonce.js";
export { parseSignedRequestHeaders } from "./signed-request.js";
export { buildSigningInput } from "./signing-input.js";
export type { SigningInputParts } from "./signing-input.js";
export { verifyRequestSignature } from "./signature.js";
export type { VerifySignatureParams } from "./signature.js";
export { validateTimestampWithinSkew } from "./timing.js";
export type { TimestampValidationResult } from "./timing.js";
export {
  compareProtocolCompatibility,
  parseProtocolVersion
} from "./version.js";
export type { CompatibilityResult, ProtocolVersionParts } from "./version.js";
export { isCredentialRevoked } from "./revocation.js";
export type { CredentialRevocationRecord } from "./revocation.js";
export { validateSignedRequest } from "./validate.js";
export type {
  ValidateSignedRequestOptions,
  ValidateSignedRequestResult
} from "./validate.js";
