import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

import type { SqlConnection } from "@sitepilot/sql";

import type { SecretKey, SecureStorage } from "./secure-storage.js";

/**
 * Secure storage for the hosted server, in its database. The desktop keeps
 * using Electron's safeStorage; a server has no OS keychain, so each secret
 * is encrypted with AES-256-GCM under SITEPILOT_SECRETS_KEY, which only the
 * server's environment holds. The database alone never reveals a secret.
 *
 * Each ciphertext is bound to its namespace and key ID, so a row can't be
 * moved to another secret's slot, and records which key encrypted it.
 */

const AAD_PREFIX = "sitepilot.secret/v1";

export const SECRETS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS secrets (
  namespace TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key_id)
)`;

/** A 32-byte key, base64, or null when missing or malformed. */
export function parseSecretsKey(value: string | undefined): Buffer | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : null;
}

function fingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function aad(secret: SecretKey): Buffer {
  return Buffer.from(`${AAD_PREFIX}\n${secret.namespace}\n${secret.keyId}`, "utf8");
}

type SecretRow = {
  keyFingerprint: string;
  nonce: string;
  ciphertext: string;
};

export class EncryptedSqlSecureStorage implements SecureStorage {
  readonly #fingerprint: string;

  public constructor(
    private readonly sql: SqlConnection,
    private readonly key: Buffer
  ) {
    if (key.length !== 32) {
      throw new TypeError("The secrets key must be 32 bytes.");
    }
    this.#fingerprint = fingerprint(key);
  }

  public async get(secret: SecretKey): Promise<string | undefined> {
    const row = await this.sql
      .prepare<{ namespace: string; keyId: string }, SecretRow>(
        `SELECT key_fingerprint AS "keyFingerprint", nonce, ciphertext
         FROM secrets WHERE namespace = @namespace AND key_id = @keyId`
      )
      .get({ namespace: secret.namespace, keyId: secret.keyId });
    if (!row) return undefined;
    if (row.keyFingerprint !== this.#fingerprint) {
      throw new Error(
        `Secret ${secret.namespace}/${secret.keyId} was stored under a different SITEPILOT_SECRETS_KEY.`
      );
    }
    const sealed = Buffer.from(row.ciphertext, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(row.nonce, "base64")
    );
    decipher.setAAD(aad(secret));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new Error(
        `Secret ${secret.namespace}/${secret.keyId} failed its integrity check.`
      );
    }
  }

  public async set(secret: SecretKey, value: string): Promise<void> {
    if (secret.keyId.length === 0) {
      throw new Error("SecretKey.keyId must be non-empty");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad(secret));
    const sealed = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag()
    ]);
    const now = new Date().toISOString();
    await this.sql
      .prepare(
        `INSERT INTO secrets (namespace, key_id, key_fingerprint, nonce, ciphertext, created_at, updated_at)
         VALUES (@namespace, @keyId, @keyFingerprint, @nonce, @ciphertext, @now, @now)
         ON CONFLICT (namespace, key_id) DO UPDATE SET
           key_fingerprint = excluded.key_fingerprint,
           nonce = excluded.nonce,
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at`
      )
      .run({
        namespace: secret.namespace,
        keyId: secret.keyId,
        keyFingerprint: this.#fingerprint,
        nonce: nonce.toString("base64"),
        ciphertext: sealed.toString("base64"),
        now
      });
  }

  public async delete(secret: SecretKey): Promise<void> {
    await this.sql
      .prepare(`DELETE FROM secrets WHERE namespace = @namespace AND key_id = @keyId`)
      .run({ namespace: secret.namespace, keyId: secret.keyId });
  }

  public async has(secret: SecretKey): Promise<boolean> {
    const row = await this.sql
      .prepare<{ namespace: string; keyId: string }, { present: number }>(
        `SELECT 1 AS present FROM secrets WHERE namespace = @namespace AND key_id = @keyId`
      )
      .get({ namespace: secret.namespace, keyId: secret.keyId });
    return row !== undefined;
  }
}
