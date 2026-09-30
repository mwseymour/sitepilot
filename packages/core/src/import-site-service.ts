import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  ActionId,
  AuditEntry,
  AuditEntryId,
  RequestId,
  SiteConfigId,
  SiteConfigVersion,
  SiteId
} from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

const bundleSchema = z.object({
  kind: z.literal("sitepilot_site_export"),
  version: z.number().int().positive(),
  exportId: z.string().min(1).optional(),
  exportedAt: z.string().min(1),
  protocolVersion: z.string().min(1),
  site: z.object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    baseUrl: z.string().url(),
    environment: z.enum(["production", "staging", "development"]),
    activationStatus: z.enum(["inactive", "config_required", "active"]),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1)
  }),
  siteConfigVersions: z.array(
    z.object({
      id: z.string().min(1),
      siteId: z.string().min(1),
      version: z.number().int().nonnegative(),
      isActive: z.boolean(),
      summary: z.string(),
      requiredSectionsComplete: z.boolean(),
      document: z.record(z.string(), z.unknown()),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1)
    })
  ),
  auditEntries: z.array(
    z.object({
      id: z.string().min(1),
      siteId: z.string().min(1),
      requestId: z.string().optional(),
      actionId: z.string().optional(),
      eventType: z.string().min(1),
      actor: z.unknown(),
      metadata: z.record(z.string(), z.unknown()),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1)
    })
  )
});

export type ApplySiteBundleResult =
  | {
      ok: true;
      siteId: SiteId;
      auditsImported: number;
      configsImported: number;
    }
  | { ok: false; code: string; message: string };

/**
 * Merges config versions and audit rows from an export file into the local DB.
 * Existing config versions for the same (site, version) are skipped. Audit rows
 * are always appended with new ids (T35).
 */
export async function applySiteImportBundle(
  bundleJson: string
): Promise<ApplySiteBundleResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundleJson) as unknown;
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Bundle is not valid JSON."
    };
  }

  const bundle = bundleSchema.safeParse(parsed);
  if (!bundle.success) {
    return {
      ok: false,
      code: "invalid_bundle",
      message: "Bundle failed schema validation."
    };
  }

  const data = bundle.data;
  const siteId = data.site.id as SiteId;
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return {
      ok: false,
      code: "site_not_found",
      message:
        "This database has no site with the bundle’s site id. Register the site first."
    };
  }

  const existingConfigs =
    await db.repositories.siteConfigs.listVersions(siteId);
  const haveVersion = new Set(existingConfigs.map((c) => c.version));
  let configsImported = 0;

  for (const row of data.siteConfigVersions) {
    if (row.siteId !== siteId) {
      continue;
    }
    if (haveVersion.has(row.version)) {
      continue;
    }
    const cfg: SiteConfigVersion = {
      id: randomUUID() as SiteConfigId,
      siteId,
      version: row.version,
      isActive: false,
      summary: row.summary,
      requiredSectionsComplete: row.requiredSectionsComplete,
      document: row.document,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
    await db.repositories.siteConfigs.save(cfg);
    haveVersion.add(row.version);
    configsImported += 1;
  }

  let auditsImported = 0;
  const importTag = {
    sourceExportId: data.exportId ?? null,
    bundleExportedAt: data.exportedAt
  };

  for (const row of data.auditEntries) {
    if (row.siteId !== siteId) {
      continue;
    }
    const entry: AuditEntry = {
      id: randomUUID() as AuditEntryId,
      siteId,
      eventType: row.eventType as AuditEntry["eventType"],
      actor: row.actor as AuditEntry["actor"],
      metadata: {
        ...row.metadata,
        sitepilotImport: {
          ...importTag,
          sourceAuditId: row.id
        }
      } as AuditEntry["metadata"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.requestId !== undefined
        ? { requestId: row.requestId as RequestId }
        : {}),
      ...(row.actionId !== undefined
        ? { actionId: row.actionId as ActionId }
        : {})
    };
    await db.repositories.auditEntries.append(entry);
    auditsImported += 1;
  }

  return { ok: true, siteId, auditsImported, configsImported };
}
