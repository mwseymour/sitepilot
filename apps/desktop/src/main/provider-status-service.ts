import type { ProviderStatusResponse } from "@sitepilot/contracts";

import { getSecureStorage } from "./app-secure-storage.js";

export async function readProviderStatus(): Promise<ProviderStatusResponse> {
  const storage = getSecureStorage();
  const configured: ProviderStatusResponse["configuredProviders"] = [];

  if (await storage.has({ namespace: "provider", keyId: "openai" })) {
    configured.push({
      provider: "openai",
      label: "OpenAI",
      isDefault: configured.length === 0
    });
  }

  if (await storage.has({ namespace: "provider", keyId: "anthropic" })) {
    configured.push({
      provider: "anthropic",
      label: "Anthropic",
      isDefault: configured.length === 0
    });
  }

  return { configuredProviders: configured };
}
