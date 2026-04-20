import type { AuditEntry, RequestId, SiteId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

export type ListAuditEntriesResult =
  | { ok: true; entries: AuditEntry[] }
  | { ok: false; code: string; message: string };

export async function listAuditEntriesForSite(input: {
  siteId: SiteId;
  requestId?: RequestId;
  limit?: number;
}): Promise<ListAuditEntriesResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }

  const limit = input.limit ?? 200;

  if (input.requestId !== undefined) {
    const request = await db.repositories.requests.getById(input.requestId);
    if (!request || request.siteId !== input.siteId) {
      return {
        ok: false,
        code: "request_not_found",
        message: "Request not found for this site."
      };
    }
    const entries = await db.repositories.auditEntries.listByRequestId(
      input.requestId
    );
    const slice = entries.length > limit ? entries.slice(-limit) : entries;
    return { ok: true, entries: slice };
  }

  const entries = await db.repositories.auditEntries.listBySiteId(input.siteId);
  return { ok: true, entries: entries.slice(0, limit) };
}
