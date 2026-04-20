import type { ProviderStatusResponse } from "@sitepilot/contracts";
import type { SiteId, WorkspaceId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import {
  loadPlannerPreferences,
  saveGlobalPlannerPreferences,
  saveWorkspacePlannerPreferences,
  type PlannerPreferences
} from "./planner-preferences-service.js";

export type SettingsStateResult =
  | {
      ok: true;
      configuredProviders: ProviderStatusResponse["configuredProviders"];
      planner: PlannerPreferences;
      siteHasSigningSecret?: boolean;
    }
  | { ok: false; code: string; message: string };

export async function getSettingsState(input: {
  workspaceId?: WorkspaceId;
  siteId?: SiteId;
}): Promise<SettingsStateResult> {
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

  const planner = await loadPlannerPreferences(
    storage,
    input.workspaceId !== undefined
      ? (input.workspaceId as WorkspaceId)
      : undefined
  );

  let siteHasSigningSecret: boolean | undefined;
  if (input.siteId !== undefined) {
    const site = await getDatabase().repositories.sites.getById(input.siteId);
    if (!site) {
      return { ok: false, code: "site_not_found", message: "Site not found." };
    }
    siteHasSigningSecret = await storage.has({
      namespace: "site",
      keyId: input.siteId
    });
  }

  return {
    ok: true,
    configuredProviders: configured,
    planner,
    ...(siteHasSigningSecret !== undefined ? { siteHasSigningSecret } : {})
  };
}

export async function setProviderSecret(input: {
  provider: "openai" | "anthropic";
  secret: string;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const storage = getSecureStorage();
  await storage.set(
    { namespace: "provider", keyId: input.provider },
    input.secret.trim()
  );
  return { ok: true };
}

export async function clearProviderSecret(input: {
  provider: "openai" | "anthropic";
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  await getSecureStorage().delete({
    namespace: "provider",
    keyId: input.provider
  });
  return { ok: true };
}

export async function setPlannerPreferences(input: {
  workspaceId?: WorkspaceId;
  preferences: PlannerPreferences;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const storage = getSecureStorage();
  if (input.workspaceId !== undefined) {
    await saveWorkspacePlannerPreferences(storage, input.workspaceId, {
      preferredProvider: input.preferences.preferredProvider,
      openaiModel: input.preferences.openaiModel,
      anthropicModel: input.preferences.anthropicModel
    });
  } else {
    await saveGlobalPlannerPreferences(storage, input.preferences);
  }
  return { ok: true };
}

export async function clearSiteSigningSecret(input: {
  siteId: SiteId;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  await getSecureStorage().delete({ namespace: "site", keyId: input.siteId });
  return { ok: true };
}
