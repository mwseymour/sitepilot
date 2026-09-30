import { join } from "node:path";

import { configureRuntimeContext } from "@sitepilot/core/runtime-context";
import { initializeDatabase } from "@sitepilot/repositories";
import type { SecureStorage } from "@sitepilot/services";
import { app, safeStorage } from "electron";

import { createElectronSecureStorage } from "./electron-secure-storage.js";

/**
 * safeStorage only works once the app is ready, so the store is created on
 * first use rather than at launch.
 */
function lazyElectronSecureStorage(root: string): SecureStorage {
  let storage: SecureStorage | null = null;
  const resolve = (): SecureStorage =>
    (storage ??= createElectronSecureStorage({ root, safeStorage }));
  return {
    get: (key) => resolve().get(key),
    set: (key, value) => resolve().set(key, value),
    delete: (key) => resolve().delete(key),
    has: (key) => resolve().has(key)
  };
}

/**
 * Gives the shared services (@sitepilot/core) the desktop's local SQLite
 * database, Electron's secure storage and the app's data folder. The hosted
 * server configures the same context with Postgres instead.
 */
export function configureDesktopRuntime(): void {
  const userDataPath = app.getPath("userData");
  configureRuntimeContext({
    userDataPath,
    database: initializeDatabase({
      filePath: join(userDataPath, "sitepilot.sqlite")
    }),
    secureStorage: lazyElectronSecureStorage(join(userDataPath, "secure-store"))
  });
}
