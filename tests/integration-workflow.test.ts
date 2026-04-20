import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuditEntry,
  AuditEntryId,
  RequestId,
  Site,
  SiteId,
  Workspace
} from "@sitepilot/domain";
import { initializeDatabase } from "@sitepilot/repositories";

const temporaryDirectories: string[] = [];
const now = "2026-04-19T12:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openDb() {
  const directory = mkdtempSync(join(tmpdir(), "sitepilot-int-"));
  temporaryDirectories.push(directory);
  return initializeDatabase({
    filePath: join(directory, "sitepilot.sqlite")
  });
}

describe("integration-style persistence (T34)", () => {
  it("filters audit entries for a site (request, event type, rollback)", async () => {
    const database = openDb();

    try {
      const workspace: Workspace = {
        id: "workspace-1" as Workspace["id"],
        name: "W",
        slug: "w",
        ownerUserProfileId: "user-1" as Workspace["ownerUserProfileId"],
        createdAt: now,
        updatedAt: now
      };
      const site: Site = {
        id: "site-1" as SiteId,
        workspaceId: workspace.id,
        name: "Example",
        baseUrl: "https://example.com",
        environment: "production",
        activationStatus: "active",
        createdAt: now,
        updatedAt: now
      };
      await database.repositories?.workspaces.save(workspace);
      await database.repositories?.sites.save(site);

      const rid = "req-1" as RequestId;
      const entries: AuditEntry[] = [
        {
          id: "a1" as AuditEntryId,
          siteId: site.id,
          requestId: rid,
          eventType: "plan_generated",
          actor: { kind: "assistant" },
          metadata: {},
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:00.000Z"
        },
        {
          id: "a2" as AuditEntryId,
          siteId: site.id,
          requestId: rid,
          eventType: "execution_failed",
          actor: { kind: "system" },
          metadata: { err: true },
          createdAt: "2026-04-19T11:00:00.000Z",
          updatedAt: "2026-04-19T11:00:00.000Z"
        },
        {
          id: "a3" as AuditEntryId,
          siteId: site.id,
          requestId: rid,
          actionId: "act-9",
          eventType: "rollback_recorded",
          actor: { kind: "system" },
          metadata: { snapshot: {} },
          createdAt: "2026-04-19T12:00:00.000Z",
          updatedAt: "2026-04-19T12:00:00.000Z"
        }
      ];
      for (const e of entries) {
        await database.repositories?.auditEntries.append(e);
      }

      const byRequest = await database.repositories!.auditEntries.queryForSite({
        siteId: site.id,
        requestId: rid,
        limit: 50
      });
      expect(byRequest).toHaveLength(3);

      const failedOnly = await database.repositories!.auditEntries.queryForSite(
        {
          siteId: site.id,
          executionOutcome: "failed",
          limit: 50
        }
      );
      expect(failedOnly.map((e) => e.eventType)).toEqual(["execution_failed"]);

      const rollbackOnly =
        await database.repositories!.auditEntries.queryForSite({
          siteId: site.id,
          rollbackRelatedOnly: true,
          limit: 50
        });
      expect(rollbackOnly).toHaveLength(1);
      expect(rollbackOnly[0]?.actionId).toBe("act-9");
    } finally {
      database.close();
    }
  });
});
