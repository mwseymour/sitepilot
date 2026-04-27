import type {
  ProviderStatusResponse,
  SitePlannerSettings,
  UiPreferences,
  WordPressCoreBlockIndex
} from "@sitepilot/contracts";
import type { SiteId, WorkspaceId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import {
  getWordPressCoreBlockIndex,
  isWordPressCoreRoot,
  reindexWordPressCoreBlockIndex
} from "./core-block-index-service.js";
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
      uiPreferences: UiPreferences;
      sitePlannerSettings?: SitePlannerSettings;
      siteHasSigningSecret?: boolean;
      coreBlockIndex?: WordPressCoreBlockIndex | null;
      wordpressCoreSourcePath?: string | null;
    }
  | { ok: false; code: string; message: string };

const DEFAULT_SITE_PLANNER_SETTINGS: SitePlannerSettings = {
  bypassApprovalRequests: false
};

const DEFAULT_UI_PREFERENCES: UiPreferences = {
  developerToolsEnabled: false,
  preserveOriginalImageUploads: false
};

function sitePlannerSettingsKey(siteId: SiteId) {
  return {
    namespace: "app",
    keyId: `planner_settings:site:${siteId}`
  } as const;
}

function uiPreferencesKey() {
  return {
    namespace: "app",
    keyId: "ui_preferences:global"
  } as const;
}

function wordpressCoreSourcePathKey() {
  return {
    namespace: "app",
    keyId: "wordpress_core_source_path"
  } as const;
}

function parseSitePlannerSettings(
  raw: string | undefined
): Partial<SitePlannerSettings> {
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const record = value as Record<string, unknown>;
    const out: Partial<SitePlannerSettings> = {};
    if (typeof record.bypassApprovalRequests === "boolean") {
      out.bypassApprovalRequests = record.bypassApprovalRequests;
    }
    return out;
  } catch {
    return {};
  }
}

function parseUiPreferences(raw: string | undefined): Partial<UiPreferences> {
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const record = value as Record<string, unknown>;
    const out: Partial<UiPreferences> = {};
    if (typeof record.developerToolsEnabled === "boolean") {
      out.developerToolsEnabled = record.developerToolsEnabled;
    }
    if (typeof record.preserveOriginalImageUploads === "boolean") {
      out.preserveOriginalImageUploads = record.preserveOriginalImageUploads;
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadSitePlannerSettings(
  storage: ReturnType<typeof getSecureStorage>,
  siteId: SiteId
): Promise<SitePlannerSettings> {
  const raw = await storage.get(sitePlannerSettingsKey(siteId));
  return {
    ...DEFAULT_SITE_PLANNER_SETTINGS,
    ...parseSitePlannerSettings(raw)
  };
}

export async function saveSitePlannerSettings(
  storage: ReturnType<typeof getSecureStorage>,
  siteId: SiteId,
  settings: SitePlannerSettings
): Promise<void> {
  await storage.set(sitePlannerSettingsKey(siteId), JSON.stringify(settings));
}

export async function loadUiPreferences(
  storage: ReturnType<typeof getSecureStorage>
): Promise<UiPreferences> {
  const raw = await storage.get(uiPreferencesKey());
  return {
    ...DEFAULT_UI_PREFERENCES,
    ...parseUiPreferences(raw)
  };
}

export async function saveUiPreferences(
  storage: ReturnType<typeof getSecureStorage>,
  preferences: UiPreferences
): Promise<void> {
  await storage.set(uiPreferencesKey(), JSON.stringify(preferences));
}

export async function loadWordPressCoreSourcePath(
  storage: ReturnType<typeof getSecureStorage>
): Promise<string | null> {
  const raw = await storage.get(wordpressCoreSourcePathKey());
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function saveWordPressCoreSourcePath(
  storage: ReturnType<typeof getSecureStorage>,
  sourcePath: string | null
): Promise<void> {
  if (sourcePath === null || sourcePath.trim().length === 0) {
    await storage.delete(wordpressCoreSourcePathKey());
    return;
  }
  await storage.set(wordpressCoreSourcePathKey(), sourcePath.trim());
}

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
  const uiPreferences = await loadUiPreferences(storage);
  const wordpressCoreSourcePath = await loadWordPressCoreSourcePath(storage);
  const coreBlockIndex = await getWordPressCoreBlockIndex(
    wordpressCoreSourcePath ?? undefined
  );

  let siteHasSigningSecret: boolean | undefined;
  let sitePlannerSettings: SitePlannerSettings | undefined;
  if (input.siteId !== undefined) {
    const site = await getDatabase().repositories.sites.getById(input.siteId);
    if (!site) {
      return { ok: false, code: "site_not_found", message: "Site not found." };
    }
    siteHasSigningSecret = await storage.has({
      namespace: "site",
      keyId: input.siteId
    });
    sitePlannerSettings = await loadSitePlannerSettings(storage, input.siteId);
  }

  return {
    ok: true,
    configuredProviders: configured,
    planner,
    uiPreferences,
    coreBlockIndex,
    wordpressCoreSourcePath,
    ...(sitePlannerSettings !== undefined ? { sitePlannerSettings } : {}),
    ...(siteHasSigningSecret !== undefined ? { siteHasSigningSecret } : {})
  };
}

export async function reindexCoreBlocks(): Promise<
  | { ok: true; coreBlockIndex: WordPressCoreBlockIndex | null }
  | { ok: false; code: string; message: string }
> {
  const storage = getSecureStorage();
  const wordpressCoreSourcePath = await loadWordPressCoreSourcePath(storage);
  const coreBlockIndex = await reindexWordPressCoreBlockIndex(
    wordpressCoreSourcePath ?? undefined
  );
  return {
    ok: true,
    coreBlockIndex
  };
}

export async function setWordPressCoreSourcePath(input: {
  path: string | null;
}): Promise<
  | { ok: true; path: string | null }
  | { ok: false; code: string; message: string }
> {
  const storage = getSecureStorage();
  if (input.path !== null) {
    const candidate = input.path.trim();
    if (candidate.length === 0) {
      await saveWordPressCoreSourcePath(storage, null);
      return { ok: true, path: null };
    }
    const isValid = await isWordPressCoreRoot(candidate);
    if (!isValid) {
      return {
        ok: false,
        code: "invalid_wordpress_core_source",
        message:
          "That folder does not look like a WordPress core snapshot. Expected wp-includes/version.php and wp-includes/blocks."
      };
    }
    await saveWordPressCoreSourcePath(storage, candidate);
    return { ok: true, path: candidate };
  }
  await saveWordPressCoreSourcePath(storage, null);
  return { ok: true, path: null };
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

export async function setSitePlannerSettings(input: {
  siteId: SiteId;
  settings: SitePlannerSettings;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  await saveSitePlannerSettings(
    getSecureStorage(),
    input.siteId,
    input.settings
  );
  return { ok: true };
}

export async function setUiPreferences(input: {
  preferences: UiPreferences;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  await saveUiPreferences(getSecureStorage(), input.preferences);
  return { ok: true };
}
