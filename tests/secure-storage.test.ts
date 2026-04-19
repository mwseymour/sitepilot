import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createElectronSecureStorage,
  type SafeStorageLike
} from "../apps/desktop/src/main/electron-secure-storage.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Deterministic mock: mimics encrypt/decrypt without Electron. Real runtime
 * uses OS-backed `safeStorage` from Electron.
 */
function createMockSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) =>
      Buffer.from(`mock:${plainText}`, "utf8"),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("mock:")) {
        throw new Error("invalid ciphertext");
      }
      return text.slice("mock:".length);
    }
  };
}

describe("electron secure storage (safeStorage-backed layout)", () => {
  it("stores and retrieves a secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "sitepilot-sec-"));
    temporaryDirectories.push(root);

    const storage = createElectronSecureStorage({
      root,
      safeStorage: createMockSafeStorage()
    });

    const key = { namespace: "provider" as const, keyId: "profile-openai" };
    await storage.set(key, "sk-test");
    await expect(storage.get(key)).resolves.toBe("sk-test");
  });

  it("returns undefined for a missing secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "sitepilot-sec-"));
    temporaryDirectories.push(root);

    const storage = createElectronSecureStorage({
      root,
      safeStorage: createMockSafeStorage()
    });

    const key = { namespace: "site" as const, keyId: "missing" };
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.has(key)).resolves.toBe(false);
  });

  it("overwrites on set for rotation-friendly semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "sitepilot-sec-"));
    temporaryDirectories.push(root);

    const storage = createElectronSecureStorage({
      root,
      safeStorage: createMockSafeStorage()
    });

    const key = { namespace: "signing" as const, keyId: "site-1" };
    await storage.set(key, "first");
    await expect(storage.get(key)).resolves.toBe("first");

    await storage.set(key, "rotated");
    await expect(storage.get(key)).resolves.toBe("rotated");
  });

  it("deletes a stored secret and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "sitepilot-sec-"));
    temporaryDirectories.push(root);

    const storage = createElectronSecureStorage({
      root,
      safeStorage: createMockSafeStorage()
    });

    const key = { namespace: "oauth" as const, keyId: "refresh-1" };
    await storage.set(key, "token");
    await expect(storage.has(key)).resolves.toBe(true);

    await storage.delete(key);
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.has(key)).resolves.toBe(false);

    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it("throws when encryption is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "sitepilot-sec-"));
    temporaryDirectories.push(root);

    expect(() =>
      createElectronSecureStorage({
        root,
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: () => Buffer.alloc(0),
          decryptString: () => ""
        }
      })
    ).toThrow(/safeStorage is unavailable/);
  });

  it("rejects empty keyId", async () => {
    const root = mkdtempSync(join(tmpdir(), "sitepilot-sec-"));
    temporaryDirectories.push(root);

    const storage = createElectronSecureStorage({
      root,
      safeStorage: createMockSafeStorage()
    });

    const key = { namespace: "provider" as const, keyId: "" };
    await expect(storage.get(key)).rejects.toThrow(/keyId/);
    await expect(storage.set(key, "x")).rejects.toThrow(/keyId/);
    await expect(storage.delete(key)).rejects.toThrow(/keyId/);
    await expect(storage.has(key)).rejects.toThrow(/keyId/);
  });
});
