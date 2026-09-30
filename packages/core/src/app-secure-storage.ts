import type { SecureStorage } from "@sitepilot/services";

import { getRuntimeSecureStorage } from "./runtime-context.js";

/**
 * Where site secrets and provider keys live: Electron's safeStorage in the
 * desktop app, the server's own store when hosted. The host app configures it
 * at startup with configureRuntimeContext.
 */
export function getSecureStorage(): SecureStorage {
  const storage = getRuntimeSecureStorage();
  if (!storage) {
    throw new Error(
      "SitePilot's secure storage isn't configured. The desktop app and the server set it with configureRuntimeContext at startup."
    );
  }
  return storage;
}
