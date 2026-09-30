import type {
  ActionId,
  AuditEntry,
  AuditEventType,
  RequestId,
  SiteId
} from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

export type ListAuditEntriesResult =
  | { ok: true; entries: AuditEntry[] }
  | { ok: false; code: string; message: string };

export async function listAuditEntriesForSite(input: {
  siteId: SiteId;
  requestId?: RequestId;
  actionId?: ActionId;
  eventTypes?: AuditEventType[];
  since?: string;
  until?: string;
  executionOutcome?: "any" | "failed" | "succeeded";
  rollbackRelatedOnly?: boolean;
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
  }

  const entries = await db.repositories.auditEntries.queryForSite({
    siteId: input.siteId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    ...(input.eventTypes !== undefined && input.eventTypes.length > 0
      ? { eventTypes: input.eventTypes }
      : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(input.executionOutcome !== undefined && input.executionOutcome !== "any"
      ? { executionOutcome: input.executionOutcome }
      : {}),
    ...(input.rollbackRelatedOnly === true
      ? { rollbackRelatedOnly: true }
      : {}),
    limit
  });

  return { ok: true, entries };
}
