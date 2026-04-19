export type CredentialRevocationRecord = {
  credentialFingerprint: string;
  revokedAt: string;
  reason?: string;
};

/**
 * Returns true when `fingerprint` appears on the revocation list with
 * `revokedAt` on or before `nowIso`.
 */
export function isCredentialRevoked(
  fingerprint: string,
  revokeList: ReadonlyArray<CredentialRevocationRecord>,
  nowIso: string
): boolean {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    return false;
  }
  for (const entry of revokeList) {
    if (entry.credentialFingerprint !== fingerprint) {
      continue;
    }
    const at = Date.parse(entry.revokedAt);
    if (Number.isNaN(at)) {
      continue;
    }
    if (at <= now) {
      return true;
    }
  }
  return false;
}
