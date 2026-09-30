import { randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializePostgresDatabase } from "@sitepilot/repositories";
import {
  EncryptedSqlSecureStorage,
  SECRETS_TABLE_SQL,
  parseSecretsKey,
  type SecretKey
} from "@sitepilot/services";
import { sqliteConnection, type SqlConnection } from "@sitepilot/sql";

import {
  TEST_POSTGRES_URL,
  createTestPostgresDatabase
} from "./postgres-test-database.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sqliteSql(): Promise<SqlConnection> {
  const database = new Database(":memory:");
  cleanups.push(async () => database.close());
  const sql = sqliteConnection(database);
  await sql.exec(SECRETS_TABLE_SQL);
  return sql;
}

async function postgresSql(): Promise<SqlConnection> {
  const created = await createTestPostgresDatabase();
  cleanups.push(created.drop);
  const database = await initializePostgresDatabase({ connectionString: created.url, max: 2 });
  cleanups.push(database.close);
  return database.sql;
}

const backends: Array<[string, () => Promise<SqlConnection>]> = [
  ["sqlite", sqliteSql],
  ...(TEST_POSTGRES_URL ? [["postgres", postgresSql] as [string, () => Promise<SqlConnection>]] : [])
];

const siteSecret: SecretKey = { namespace: "site", keyId: "site-1:shared-secret" };

describe.each(backends)("encrypted secure storage on %s", (_name, open) => {
  it("round-trips a secret without storing it in plaintext", async () => {
    const sql = await open();
    const storage = new EncryptedSqlSecureStorage(sql, randomBytes(32));
    expect(await storage.has(siteSecret)).toBe(false);
    expect(await storage.get(siteSecret)).toBeUndefined();

    await storage.set(siteSecret, "shared-secret-value");
    expect(await storage.get(siteSecret)).toBe("shared-secret-value");
    expect(await storage.has(siteSecret)).toBe(true);
    await storage.set(siteSecret, "rotated-value");
    expect(await storage.get(siteSecret)).toBe("rotated-value");

    const rows = await sql
      .prepare<[], { ciphertext: string; nonce: string }>(`SELECT ciphertext, nonce FROM secrets`)
      .all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("rotated-value");
    expect(Buffer.from(rows[0]!.ciphertext, "base64").toString("utf8")).not.toContain("rotated");

    await storage.delete(siteSecret);
    expect(await storage.has(siteSecret)).toBe(false);
  });

  it("refuses a different key clearly", async () => {
    const sql = await open();
    await new EncryptedSqlSecureStorage(sql, randomBytes(32)).set(siteSecret, "value");
    await expect(
      new EncryptedSqlSecureStorage(sql, randomBytes(32)).get(siteSecret)
    ).rejects.toThrow("stored under a different SITEPILOT_SECRETS_KEY");
  });

  it("detects a tampered or moved ciphertext", async () => {
    const sql = await open();
    const storage = new EncryptedSqlSecureStorage(sql, randomBytes(32));
    await storage.set(siteSecret, "value");
    const other: SecretKey = { namespace: "site", keyId: "site-2:shared-secret" };

    // Copying one secret's row into another's slot fails its binding.
    await sql
      .prepare(
        `INSERT INTO secrets (namespace, key_id, key_fingerprint, nonce, ciphertext, created_at, updated_at)
         SELECT namespace, @otherKeyId, key_fingerprint, nonce, ciphertext, created_at, updated_at
         FROM secrets WHERE key_id = @keyId`
      )
      .run({ otherKeyId: other.keyId, keyId: siteSecret.keyId });
    await expect(storage.get(other)).rejects.toThrow("failed its integrity check");

    // Flipping a byte of the ciphertext does too.
    const row = await sql
      .prepare<{ keyId: string }, { ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE key_id = @keyId`)
      .get({ keyId: siteSecret.keyId });
    const bytes = Buffer.from(row!.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await sql
      .prepare(`UPDATE secrets SET ciphertext = @ciphertext WHERE key_id = @keyId`)
      .run({ ciphertext: bytes.toString("base64"), keyId: siteSecret.keyId });
    await expect(storage.get(siteSecret)).rejects.toThrow("failed its integrity check");
  });
});

describe("parseSecretsKey", () => {
  it("accepts only 32 bytes of base64", () => {
    const key = randomBytes(32).toString("base64");
    expect(parseSecretsKey(key)?.length).toBe(32);
    expect(parseSecretsKey(` ${key}\n`)?.length).toBe(32);
    expect(parseSecretsKey(undefined)).toBeNull();
    expect(parseSecretsKey("")).toBeNull();
    expect(parseSecretsKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(parseSecretsKey("not base64 at all, but forty-four chars long!")).toBeNull();
  });
});
