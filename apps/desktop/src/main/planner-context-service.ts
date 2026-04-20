import { siteConfigSchema, type PlannerContext } from "@sitepilot/contracts";
import type { ChatThreadId, SiteId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { buildPlannerContext } from "@sitepilot/services";

export type BuildPlannerContextResult =
  | { ok: true; context: PlannerContext }
  | { ok: false; code: string; message: string };

async function loadLatestSiteConfigDocument(
  siteId: SiteId
): Promise<ReturnType<typeof siteConfigSchema.parse> | null> {
  const db = getDatabase();
  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latest = sorted[0];
  if (!latest) {
    return null;
  }
  try {
    return siteConfigSchema.parse(latest.document);
  } catch {
    return null;
  }
}

export async function buildPlannerContextForThread(
  siteId: SiteId,
  threadId: ChatThreadId
): Promise<BuildPlannerContextResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  if (site.activationStatus !== "active") {
    return {
      ok: false,
      code: "site_not_active",
      message: "Site must be active to build planner context."
    };
  }

  const thread = await db.repositories.chatThreads.getById(threadId);
  if (!thread || thread.siteId !== siteId) {
    return {
      ok: false,
      code: "thread_not_found",
      message: "Thread not found for this site."
    };
  }

  const [siteConfig, discovery, messages] = await Promise.all([
    loadLatestSiteConfigDocument(siteId),
    db.repositories.discoverySnapshots.getLatest(siteId),
    db.repositories.chatMessages.listByThreadId(threadId)
  ]);

  const builtAt = new Date().toISOString();

  const context = buildPlannerContext({
    siteId,
    threadId,
    builtAt,
    siteConfig,
    discoverySnapshot: discovery,
    messages,
    targetSummaries: [],
    priorChanges: []
  });

  return { ok: true, context };
}
