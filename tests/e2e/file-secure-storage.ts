import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SecretKey, SecureStorage } from "@sitepilot/services";

function encodeKeySegment(keyId: string): string {
  return Buffer.from(keyId, "utf8").toString("base64url");
}

function filePathForKey(root: string, key: SecretKey): string {
  return join(root, key.namespace, `${encodeKeySegment(key.keyId)}.json`);
}

export function createFileSecureStorage(root: string): SecureStorage {
  mkdirSync(root, { recursive: true });

  return {
    async get(key) {
      try {
        const raw = readFileSync(filePathForKey(root, key), "utf8");
        const parsed = JSON.parse(raw) as { value?: unknown };
        return typeof parsed.value === "string" ? parsed.value : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      const filePath = filePathForKey(root, key);
      mkdirSync(join(root, key.namespace), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ value }), "utf8");
    },
    async delete(key) {
      rmSync(filePathForKey(root, key), { force: true });
    },
    async has(key) {
      return (await this.get(key)) !== undefined;
    }
  };
}
