import { createRequire } from "node:module";
import { join } from "node:path";

import type { SecureStorage } from "@sitepilot/services";

import { createElectronSecureStorage } from "./electron-secure-storage.js";
import {
  getRuntimeSecureStorage,
  resolveRuntimeChildPath
} from "./runtime-context.js";

let storage: SecureStorage | null = null;
const require = createRequire(import.meta.url);

function loadElectronSecureStorage() {
  return require("electron") as {
    app: { getPath(name: string): string };
    safeStorage: {
      isEncryptionAvailable(): boolean;
      encryptString(plainText: string): Buffer;
      decryptString(encrypted: Buffer): string;
    };
  };
}

export function getSecureStorage(): SecureStorage {
  const runtimeStorage = getRuntimeSecureStorage();
  if (runtimeStorage) {
    return runtimeStorage;
  }

  if (!storage) {
    const electron = loadElectronSecureStorage();
    storage = createElectronSecureStorage({
      root:
        resolveRuntimeChildPath("secure-store") ??
        join(electron.app.getPath("userData"), "secure-store"),
      safeStorage: electron.safeStorage
    });
  }
  return storage;
}
