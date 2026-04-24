import type { SiteConfig, SiteSummary } from "@sitepilot/contracts";
import { siteConfigSchema } from "@sitepilot/contracts";
import type { JsonObject, Site, SiteConfigId, SiteId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

function toSiteSummary(site: Site): SiteSummary {
  return {
    id: site.id,
    workspaceId: site.workspaceId,
    name: site.name,
    baseUrl: site.baseUrl,
    environment: site.environment,
    activationStatus: site.activationStatus
  };
}

function parseConfigDocument(raw: JsonObject): SiteConfig {
  return siteConfigSchema.parse(raw);
}

export type GetSiteWorkspaceResult =
  | {
      ok: true;
      site: SiteSummary;
      siteConfig: SiteConfig | null;
      discoveryRevision: number | null;
      latestDiscoverySnapshotId: string | null;
      siteConfigGeneratedFromDiscoverySnapshotId: string | null;
      discoveryReviewRequired: boolean;
    }
  | { ok: false; code: string; message: string };

async function latestDiscoverySnapshot(
  db: ReturnType<typeof getDatabase>,
  siteId: SiteId
): Promise<{
  revision: number | null;
  snapshotId: string | null;
}> {
  const snap = await db.repositories.discoverySnapshots.getLatest(siteId);
  return {
    revision: snap ? snap.revision : null,
    snapshotId: snap ? snap.id : null
  };
}

/**
 * Loads site summary and the latest config version (highest version number) for editing.
 */
export async function getSiteWorkspaceState(
  siteId: SiteId
): Promise<GetSiteWorkspaceResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return {
      ok: false,
      code: "site_not_found",
      message: "Site is not registered locally."
    };
  }

  const latestDiscovery = await latestDiscoverySnapshot(db, siteId);

  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latest = sorted[0];
  if (!latest) {
    return {
      ok: true,
      site: toSiteSummary(site),
      siteConfig: null,
      discoveryRevision: latestDiscovery.revision,
      latestDiscoverySnapshotId: latestDiscovery.snapshotId,
      siteConfigGeneratedFromDiscoverySnapshotId: null,
      discoveryReviewRequired: latestDiscovery.snapshotId !== null
    };
  }

  try {
    const siteConfig = parseConfigDocument(latest.document);
    const generatedFromDiscoverySnapshotId =
      siteConfig.metadata.generatedFromDiscoverySnapshotId ?? null;
    return {
      ok: true,
      site: toSiteSummary(site),
      siteConfig,
      discoveryRevision: latestDiscovery.revision,
      latestDiscoverySnapshotId: latestDiscovery.snapshotId,
      siteConfigGeneratedFromDiscoverySnapshotId:
        generatedFromDiscoverySnapshotId,
      discoveryReviewRequired:
        latestDiscovery.snapshotId !== null &&
        latestDiscovery.snapshotId !== generatedFromDiscoverySnapshotId
    };
  } catch {
    return {
      ok: false,
      code: "config_invalid",
      message: "Site configuration document failed validation."
    };
  }
}

export type SaveSiteConfigResult =
  | { ok: true; siteConfig: SiteConfig }
  | { ok: false; code: string; message: string };

export async function saveSiteConfigDocument(
  siteId: SiteId,
  siteConfig: SiteConfig
): Promise<SaveSiteConfigResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return {
      ok: false,
      code: "site_not_found",
      message: "Site is not registered locally."
    };
  }

  if (siteConfig.siteId !== siteId) {
    return {
      ok: false,
      code: "site_mismatch",
      message: "Site configuration siteId does not match the request."
    };
  }

  const parsed = siteConfigSchema.safeParse(siteConfig);
  if (!parsed.success) {
    return {
      ok: false,
      code: "validation_failed",
      message: parsed.error.message
    };
  }

  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const existing = versions.find((v) => v.id === parsed.data.id);
  if (!existing) {
    return {
      ok: false,
      code: "config_not_found",
      message: "Save only updates an existing configuration version."
    };
  }

  const now = new Date().toISOString();
  const doc: SiteConfig = {
    ...parsed.data,
    updatedAt: now
  };

  await db.repositories.siteConfigs.save({
    ...existing,
    requiredSectionsComplete: doc.requiredSectionsComplete,
    document: doc as unknown as JsonObject,
    updatedAt: now
  });

  return { ok: true, siteConfig: doc };
}

export type ConfirmSiteConfigResult =
  | { ok: true; site: SiteSummary; siteConfig: SiteConfig }
  | { ok: false; code: string; message: string };

export async function confirmSiteConfigActivation(
  siteId: SiteId,
  configId: SiteConfigId
): Promise<ConfirmSiteConfigResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return {
      ok: false,
      code: "site_not_found",
      message: "Site is not registered locally."
    };
  }

  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const row = versions.find((v) => v.id === configId);
  if (!row) {
    return {
      ok: false,
      code: "config_not_found",
      message: "Configuration version not found for this site."
    };
  }

  let base: SiteConfig;
  try {
    base = parseConfigDocument(row.document);
  } catch {
    return {
      ok: false,
      code: "config_invalid",
      message: "Stored configuration document failed validation."
    };
  }

  const now = new Date().toISOString();
  const activated: SiteConfig = {
    ...base,
    requiredSectionsComplete: true,
    activationStatus: "active",
    updatedAt: now
  };

  const parsed = siteConfigSchema.safeParse(activated);
  if (!parsed.success) {
    return {
      ok: false,
      code: "validation_failed",
      message:
        "Configuration is incomplete or invalid. Fill all required fields before activation."
    };
  }

  for (const v of versions) {
    const isTarget = v.id === configId;
    await db.repositories.siteConfigs.save({
      ...v,
      isActive: isTarget,
      requiredSectionsComplete: isTarget ? true : v.requiredSectionsComplete,
      document: isTarget ? (parsed.data as unknown as JsonObject) : v.document,
      updatedAt: isTarget ? now : v.updatedAt
    });
  }

  const updatedSite: Site = {
    ...site,
    activationStatus: "active",
    activeConfigId: configId,
    updatedAt: now
  };
  await db.repositories.sites.save(updatedSite);

  return {
    ok: true,
    site: toSiteSummary(updatedSite),
    siteConfig: parsed.data
  };
}
