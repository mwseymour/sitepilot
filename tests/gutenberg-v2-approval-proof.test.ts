import { createPrivateKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  gutenbergV2ApprovalSchema,
  type GutenbergV2Approval
} from "@sitepilot/contracts";
import {
  approvalKeyRequest,
  approvalSigningKeyFromPem,
  generateApprovalSigningKey,
  gutenbergV2ApprovalStatement,
  signGutenbergV2Approval,
  verifyGutenbergV2ApprovalProof
} from "@sitepilot/services";

/** The same fixture as plugins/wordpress-sitepilot/tests/ApprovalProofTest.php. */
const FIXTURE = {
  keyId: "ak_fe812c12f3ab4ce6ac5db69ac352f906",
  publicKey: "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  signature:
    "k+HTkLyfC3v8vgKlO/M6ZqaYKF9NUZjdTxcVWXGi5rXxDsZYbXq/0urY+Qpm8A96TyRQEB4v19S5kcvpaMwIBw==",
  statement:
    '{"approvalId":"approval-fixture-1","approvedAt":"2026-09-30T10:00:00.000Z","approverId":"operator-1","audience":"sitepilot.v2.write","bindingHash":"87e86d419f5f44570257abb5a0e4d07c7c0a03d0f5b02a485f7f03bbe579b39d","candidateId":"candidate-1","expiresAt":"2026-09-30T10:30:00.000Z","keyId":"ak_fe812c12f3ab4ce6ac5db69ac352f906","schemaVersion":"sitepilot.approval-statement/v1","siteId":"site-1"}'
};

function fixtureKey() {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 7)
  ]);
  const pem = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return approvalSigningKeyFromPem(pem);
}

const approval: GutenbergV2Approval = {
  schemaVersion: "sitepilot.approval/v2",
  approvalId: "approval-fixture-1",
  approverId: "operator-1",
  approvedAt: "2026-09-30T10:00:00.000Z",
  expiresAt: "2026-09-30T10:30:00.000Z",
  binding: {
    candidateId: "candidate-1",
    siteId: "site-1",
    operation: "create_draft",
    intentHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    requestedFieldsHash: "c".repeat(64),
    affectedFieldsHash: "d".repeat(64),
    capabilityFingerprint: "e".repeat(64),
    mediaManifestHash: "f".repeat(64)
  }
};

describe("approval proofs", () => {
  it("signs the same bytes the plugin checks", () => {
    const key = fixtureKey();
    expect(key.keyId).toBe(FIXTURE.keyId);
    expect(key.publicKey).toBe(FIXTURE.publicKey);
    expect(gutenbergV2ApprovalStatement(approval, key.keyId)).toBe(
      FIXTURE.statement
    );
    const signed = signGutenbergV2Approval(approval, key);
    expect(signed.proof).toEqual({
      schemaVersion: "sitepilot.approval-proof/v1",
      algorithm: "ed25519",
      keyId: FIXTURE.keyId,
      signature: FIXTURE.signature
    });
    expect(gutenbergV2ApprovalSchema.parse(signed)).toEqual(signed);
    expect(approvalKeyRequest(key)).toEqual({
      schemaVersion: "sitepilot.approval-key-request/v1",
      algorithm: "ed25519",
      keyId: FIXTURE.keyId,
      publicKey: FIXTURE.publicKey
    });
  });

  it("stops verifying once anything signed changes", () => {
    const key = fixtureKey();
    const signed = signGutenbergV2Approval(approval, key);
    expect(verifyGutenbergV2ApprovalProof(signed, key.publicKey)).toBe(true);
    expect(
      verifyGutenbergV2ApprovalProof(
        { ...signed, binding: { ...signed.binding, contentHash: "9".repeat(64) } },
        key.publicKey
      )
    ).toBe(false);
    expect(
      verifyGutenbergV2ApprovalProof(
        { ...signed, expiresAt: "2026-09-30T11:00:00.000Z" },
        key.publicKey
      )
    ).toBe(false);
    expect(
      verifyGutenbergV2ApprovalProof(
        signed,
        generateApprovalSigningKey().key.publicKey
      )
    ).toBe(false);
    expect(verifyGutenbergV2ApprovalProof(approval, key.publicKey)).toBe(false);
  });

  it("keeps a generated key usable after storing it", () => {
    const { key, privateKeyPem } = generateApprovalSigningKey();
    const restored = approvalSigningKeyFromPem(privateKeyPem);
    expect(restored.keyId).toBe(key.keyId);
    expect(restored.keyId).toMatch(/^ak_[a-f0-9]{32}$/);
    const signed = signGutenbergV2Approval(approval, restored);
    expect(verifyGutenbergV2ApprovalProof(signed, key.publicKey)).toBe(true);
    // Re-signing replaces the old proof rather than signing over it.
    expect(signGutenbergV2Approval(signed, restored)).toEqual(signed);
  });
});
