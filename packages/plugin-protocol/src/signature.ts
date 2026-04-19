import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify
} from "node:crypto";
import type { KeyObject } from "node:crypto";

export type VerifySignatureParams =
  | {
      algorithm: "hmac_sha256";
      sharedSecret: Buffer;
      signingInput: string;
      signatureHex: string;
    }
  | {
      algorithm: "ed25519";
      publicKey: string | Buffer | KeyObject;
      signingInput: string;
      signatureHex: string;
    };

function hexToBuffer(hex: string): Buffer {
  if (hex.length % 2 !== 0) {
    throw new Error("signature hex length must be even");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Verify a request signature produced by the matching signer implementation.
 * Uses constant-time comparison for HMAC digests.
 */
export function verifyRequestSignature(params: VerifySignatureParams): boolean {
  const data = Buffer.from(params.signingInput, "utf8");
  if (params.algorithm === "hmac_sha256") {
    const expected = createHmac("sha256", params.sharedSecret)
      .update(data)
      .digest();
    let provided: Buffer;
    try {
      provided = hexToBuffer(params.signatureHex);
    } catch {
      return false;
    }
    if (expected.length !== provided.length) {
      return false;
    }
    return timingSafeEqual(expected, provided);
  }

  let providedSig: Buffer;
  try {
    providedSig = hexToBuffer(params.signatureHex);
  } catch {
    return false;
  }

  let publicKey: KeyObject;
  if (typeof params.publicKey === "string") {
    publicKey = createPublicKey(params.publicKey);
  } else if (Buffer.isBuffer(params.publicKey)) {
    publicKey = createPublicKey(params.publicKey);
  } else {
    publicKey = params.publicKey;
  }

  return verify(null, data, publicKey, providedSig);
}
