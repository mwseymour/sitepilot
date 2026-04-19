import { app, safeStorage } from "electron";
import { join } from "node:path";

import type { SecureStorage } from "@sitepilot/services";

import { createElectronSecureStorage } from "./electron-secure-storage.js";

let storage: SecureStorage | null = null;

export function getSecureStorage(): SecureStorage {
  if (!storage) {
    storage = createElectronSecureStorage({
      root: join(app.getPath("userData"), "secure-store"),
      safeStorage
    });
  }
  return storage;
}
