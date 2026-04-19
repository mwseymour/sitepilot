import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type { SecretKey, SecureStorage } from "@sitepilot/services";

/**
 * Secure storage backend: Electron `safeStorage` (OS keychain / credential
 * manager) encrypts payloads; ciphertext is written under `root` inside app
 * userData — not in SQLite. This avoids native modules like keytar while
 * keeping secrets out of the database (architecture.md, Task T08).
 *
 * When `isEncryptionAvailable()` is false (unsupported environment), factory
 * throws so callers fail fast instead of persisting plaintext.
 */

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type CreateElectronSecureStorageOptions = {
  /** Directory under which versioned ciphertext files are stored (e.g. userData/secure-store). */
  root: string;
  safeStorage: SafeStorageLike;
};

function assertValidKey(key: SecretKey): void {
  if (key.keyId.length === 0) {
    throw new Error("SecretKey.keyId must be non-empty");
  }
}

/** Encode keyId so it is safe as a single path segment (no `/` or `..`). */
function encodeKeySegment(keyId: string): string {
  return Buffer.from(keyId, "utf8").toString("base64url");
}

function pathForKey(root: string, key: SecretKey): string {
  return join(root, "v1", key.namespace, encodeKeySegment(key.keyId));
}

export function createElectronSecureStorage(
  options: CreateElectronSecureStorageOptions
): SecureStorage {
  const { root, safeStorage } = options;

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "SitePilot secure storage requires OS-backed encryption (Electron safeStorage is unavailable in this environment)."
    );
  }

  async function get(key: SecretKey): Promise<string | undefined> {
    assertValidKey(key);
    const filePath = pathForKey(root, key);
    try {
      const encrypted = await readFile(filePath);
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async function set(key: SecretKey, value: string): Promise<void> {
    assertValidKey(key);
    const filePath = pathForKey(root, key);
    const encrypted = safeStorage.encryptString(value);
    await mkdir(join(root, "v1", key.namespace), { recursive: true });
    await writeFile(filePath, encrypted);
  }

  async function deleteSecret(key: SecretKey): Promise<void> {
    assertValidKey(key);
    const filePath = pathForKey(root, key);
    try {
      await unlink(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async function has(key: SecretKey): Promise<boolean> {
    assertValidKey(key);
    const filePath = pathForKey(root, key);
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  return { get, set, delete: deleteSecret, has };
}
