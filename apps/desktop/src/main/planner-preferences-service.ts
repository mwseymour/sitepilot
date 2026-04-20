import type { WorkspaceId } from "@sitepilot/domain";
import type { SecureStorage } from "@sitepilot/services";

export type PlannerPreferences = {
  preferredProvider: "auto" | "openai" | "anthropic";
  openaiModel: string;
  anthropicModel: string;
};

const DEFAULTS: PlannerPreferences = {
  preferredProvider: "auto",
  openaiModel: "gpt-4o-mini",
  anthropicModel: "claude-3-5-haiku-20241022"
};

const GLOBAL_KEY = { namespace: "app", keyId: "planner_prefs" } as const;

function workspaceKey(workspaceId: WorkspaceId) {
  return {
    namespace: "app",
    keyId: `planner_prefs:ws:${workspaceId}`
  } as const;
}

function parsePrefs(raw: string | undefined): Partial<PlannerPreferences> {
  if (!raw) {
    return {};
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return {};
    }
    const o = v as Record<string, unknown>;
    const out: Partial<PlannerPreferences> = {};
    if (
      o.preferredProvider === "auto" ||
      o.preferredProvider === "openai" ||
      o.preferredProvider === "anthropic"
    ) {
      out.preferredProvider = o.preferredProvider;
    }
    if (typeof o.openaiModel === "string" && o.openaiModel.length > 0) {
      out.openaiModel = o.openaiModel;
    }
    if (typeof o.anthropicModel === "string" && o.anthropicModel.length > 0) {
      out.anthropicModel = o.anthropicModel;
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadPlannerPreferences(
  storage: SecureStorage,
  workspaceId?: WorkspaceId
): Promise<PlannerPreferences> {
  const globalRaw = await storage.get(GLOBAL_KEY);
  let merged: PlannerPreferences = { ...DEFAULTS, ...parsePrefs(globalRaw) };
  if (workspaceId !== undefined) {
    const wsRaw = await storage.get(workspaceKey(workspaceId));
    merged = { ...merged, ...parsePrefs(wsRaw) };
  }
  return merged;
}

export async function saveGlobalPlannerPreferences(
  storage: SecureStorage,
  prefs: PlannerPreferences
): Promise<void> {
  await storage.set(GLOBAL_KEY, JSON.stringify(prefs));
}

export async function saveWorkspacePlannerPreferences(
  storage: SecureStorage,
  workspaceId: WorkspaceId,
  prefs: Partial<PlannerPreferences>
): Promise<void> {
  const cur = parsePrefs(await storage.get(workspaceKey(workspaceId)));
  await storage.set(
    workspaceKey(workspaceId),
    JSON.stringify({ ...cur, ...prefs })
  );
}

export async function clearWorkspacePlannerPreferences(
  storage: SecureStorage,
  workspaceId: WorkspaceId
): Promise<void> {
  await storage.delete(workspaceKey(workspaceId));
}
