/**
 * Partition for secret material so keys from different domains never collide.
 */
export type SecretNamespace = "provider" | "site" | "signing" | "oauth" | "app";

/**
 * Logical secret key. `keyId` is opaque to the adapter; callers may embed
 * rotation or version suffixes (for example `profile-abc` or `site-xyz:v2`).
 */
export type SecretKey = {
  readonly namespace: SecretNamespace;
  readonly keyId: string;
};

/**
 * OS-backed secret storage for the Electron main process. Implementations must
 * never persist plaintext under the SQLite database file; see Task T08.
 */
export interface SecureStorage {
  get(key: SecretKey): Promise<string | undefined>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  has(key: SecretKey): Promise<boolean>;
}
