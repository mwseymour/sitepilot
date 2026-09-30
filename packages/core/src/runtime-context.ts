import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AppDatabase } from "@sitepilot/repositories";
import type { SecureStorage } from "@sitepilot/services";

type RuntimeOverrides = {
  userDataPath?: string;
  secureStorage?: SecureStorage;
  database?: AppDatabase;
};

let overrides: RuntimeOverrides = {};

export function configureRuntimeContext(input: RuntimeOverrides): void {
  overrides = {
    ...overrides,
    ...input
  };
}

export function resetRuntimeContext(): void {
  overrides = {};
}

export function getRuntimeUserDataPath(): string | null {
  if (!overrides.userDataPath) {
    return null;
  }
  mkdirSync(overrides.userDataPath, { recursive: true });
  return overrides.userDataPath;
}

export function getRuntimeSecureStorage(): SecureStorage | null {
  return overrides.secureStorage ?? null;
}

export function getRuntimeDatabase(): AppDatabase | null {
  return overrides.database ?? null;
}

export function resolveRuntimeChildPath(fileName: string): string | null {
  const userDataPath = getRuntimeUserDataPath();
  return userDataPath ? join(userDataPath, fileName) : null;
}
