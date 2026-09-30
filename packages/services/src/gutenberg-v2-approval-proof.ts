import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject
} from "node:crypto";

import type {
  GutenbergV2Approval,
  GutenbergV2ApprovalKeyRequest
} from "@sitepilot/contracts";

import {
  canonicalGutenbergV2Json,
  hashGutenbergV2Value
} from "./gutenberg-v2-hashing.js";

/**
 * Signed approval proofs (hardening Phase 7). The approver signs a statement
 * naming the site, the candidate and the approval binding hash with an Ed25519
 * key that is separate from the request secret. A site that registered the
 * key refuses writes without a valid proof. The plugin builds the same bytes
 * in Approval_Proof::statement().
 */

export const APPROVAL_STATEMENT_SCHEMA = "sitepilot.approval-statement/v1";
export const APPROVAL_PROOF_AUDIENCE = "sitepilot.v2.write";

export type ApprovalSigningKey = {
  keyId: string;
  /** The raw 32-byte public key, base64. */
  publicKey: string;
  privateKey: KeyObject;
};

type UnsignedApproval = Omit<GutenbergV2Approval, "proof">;

/** Key IDs come from the key, so a key can't claim another's ID. */
export function approvalKeyId(rawPublicKey: Buffer): string {
  return `ak_${createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 32)}`;
}

function rawPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new TypeError("An approval key must be an Ed25519 key.");
  }
  return Buffer.from(jwk.x, "base64url");
}

export function generateApprovalSigningKey(): {
  key: ApprovalSigningKey;
  /** PKCS#8 PEM, for secure storage. */
  privateKeyPem: string;
} {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return { key: approvalSigningKeyFromPem(privateKeyPem), privateKeyPem };
}

export function approvalSigningKeyFromPem(
  privateKeyPem: string
): ApprovalSigningKey {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("An approval key must be an Ed25519 key.");
  }
  const raw = rawPublicKey(createPublicKey(privateKey));
  return {
    keyId: approvalKeyId(raw),
    publicKey: raw.toString("base64"),
    privateKey
  };
}

export function approvalKeyRequest(
  key: ApprovalSigningKey
): GutenbergV2ApprovalKeyRequest {
  return {
    schemaVersion: "sitepilot.approval-key-request/v1",
    algorithm: "ed25519",
    keyId: key.keyId,
    publicKey: key.publicKey
  };
}

/** The exact bytes a proof signs. */
export function gutenbergV2ApprovalStatement(
  approval: UnsignedApproval,
  keyId: string
): string {
  return canonicalGutenbergV2Json({
    schemaVersion: APPROVAL_STATEMENT_SCHEMA,
    audience: APPROVAL_PROOF_AUDIENCE,
    siteId: approval.binding.siteId,
    candidateId: approval.binding.candidateId,
    approvalId: approval.approvalId,
    approverId: approval.approverId,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
    bindingHash: hashGutenbergV2Value(approval.binding),
    keyId
  });
}

export function signGutenbergV2Approval(
  approval: UnsignedApproval,
  key: ApprovalSigningKey
): GutenbergV2Approval {
  const { proof: _previous, ...unsigned } = approval as GutenbergV2Approval;
  const signature = sign(
    null,
    Buffer.from(gutenbergV2ApprovalStatement(unsigned, key.keyId), "utf8"),
    key.privateKey
  );
  return {
    ...unsigned,
    proof: {
      schemaVersion: "sitepilot.approval-proof/v1",
      algorithm: "ed25519",
      keyId: key.keyId,
      signature: signature.toString("base64")
    }
  };
}

/** Checks a proof against a raw base64 public key, as the plugin does. */
export function verifyGutenbergV2ApprovalProof(
  approval: GutenbergV2Approval,
  publicKeyBase64: string
): boolean {
  if (!approval.proof) return false;
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (approvalKeyId(raw) !== approval.proof.keyId) return false;
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk"
  });
  return verify(
    null,
    Buffer.from(
      gutenbergV2ApprovalStatement(approval, approval.proof.keyId),
      "utf8"
    ),
    publicKey,
    Buffer.from(approval.proof.signature, "base64")
  );
}
