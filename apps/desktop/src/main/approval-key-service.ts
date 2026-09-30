import type {
  GutenbergV2Approval,
  GutenbergV2ApprovalKeyRequest,
  GutenbergV2ApprovalKeyResponse
} from "@sitepilot/contracts";
import {
  approvalKeyRequest,
  approvalSigningKeyFromPem,
  generateApprovalSigningKey,
  signGutenbergV2Approval,
  type ApprovalSigningKey,
  type SecretKey
} from "@sitepilot/services";

import { getSecureStorage } from "./app-secure-storage.js";

/**
 * The desktop's approval key (hardening Phase 7): an Ed25519 key, separate
 * from each site's request secret, kept in secure storage. Sites that
 * advertise approval_proof_v1 get its public key once, and from then on
 * refuse v2 writes that a person here didn't approve and sign.
 */

export const APPROVAL_PROOF_FEATURE = "approval_proof_v1";

const PRIVATE_KEY: SecretKey = { namespace: "signing", keyId: "approval-key-v1" };

function registeredKeyFor(siteId: string): SecretKey {
  return { namespace: "signing", keyId: `approval-key-registered:${siteId}` };
}

let loading: Promise<ApprovalSigningKey> | null = null;

/** The approval key, created on first use. */
export function loadApprovalSigningKey(): Promise<ApprovalSigningKey> {
  loading ??= (async () => {
    const storage = getSecureStorage();
    const stored = await storage.get(PRIVATE_KEY);
    if (stored) return approvalSigningKeyFromPem(stored);
    const generated = generateApprovalSigningKey();
    await storage.set(PRIVATE_KEY, generated.privateKeyPem);
    return generated.key;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * Signs an approval for a site that supports proofs, registering the key with
 * the site first if it doesn't have it yet. A site without the feature gets
 * the approval as it was.
 */
export async function signApprovalForSite(input: {
  siteId: string;
  features: readonly string[];
  approval: GutenbergV2Approval;
  registerApprovalKey?:
    | ((
        request: GutenbergV2ApprovalKeyRequest
      ) => Promise<GutenbergV2ApprovalKeyResponse>)
    | undefined;
}): Promise<
  | { ok: true; approval: GutenbergV2Approval }
  | { ok: false; code: string; message: string }
> {
  if (!input.features.includes(APPROVAL_PROOF_FEATURE)) {
    return { ok: true, approval: input.approval };
  }
  if (!input.registerApprovalKey) {
    return {
      ok: false,
      code: "approval_invalid",
      message: "This site needs signed approvals, but SitePilot can't register its approval key here."
    };
  }
  const key = await loadApprovalSigningKey();
  const storage = getSecureStorage();
  const registered = registeredKeyFor(input.siteId);
  if ((await storage.get(registered)) !== key.keyId) {
    try {
      await input.registerApprovalKey(approvalKeyRequest(key));
    } catch (error) {
      return {
        ok: false,
        code: "approval_invalid",
        message: `SitePilot couldn't give this site its approval key, so the change wasn't approved. ${
          error instanceof Error ? error.message : ""
        }`.trim()
      };
    }
    await storage.set(registered, key.keyId);
  }
  return { ok: true, approval: signGutenbergV2Approval(input.approval, key) };
}
