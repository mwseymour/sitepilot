import { randomUUID } from "node:crypto";

import type { SiteId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { SITEPILOT_PROTOCOL_VERSION } from "./compatibility-info.js";

export type BuildSiteBundleResult =
  | { ok: true; bundleJson: string }
  | { ok: false; code: string; message: string };

/**
 * Export site config versions and audit history for backup / compliance (T35).
 * Secrets are never included.
 */
export async function buildSiteExportBundle(
  siteId: SiteId
): Promise<BuildSiteBundleResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }

  const configs = await db.repositories.siteConfigs.listVersions(siteId);
  const audits = await db.repositories.auditEntries.queryForSite({
    siteId,
    limit: 10_000
  });

  const bundle = {
    kind: "sitepilot_site_export",
    version: 1,
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    protocolVersion: SITEPILOT_PROTOCOL_VERSION,
    site: {
      id: site.id,
      workspaceId: site.workspaceId,
      name: site.name,
      baseUrl: site.baseUrl,
      environment: site.environment,
      activationStatus: site.activationStatus,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt
    },
    siteConfigVersions: configs.map((c) => ({
      id: c.id,
      siteId: c.siteId,
      version: c.version,
      document: c.document,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    })),
    auditEntries: audits.map((e) => ({
      id: e.id,
      siteId: e.siteId,
      requestId: e.requestId,
      actionId: e.actionId,
      eventType: e.eventType,
      actor: e.actor,
      metadata: e.metadata,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt
    }))
  };

  return { ok: true, bundleJson: JSON.stringify(bundle, null, 2) };
}
