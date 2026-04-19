import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalRequest,
  AuditEntry,
  ChatThread,
  DiscoverySnapshot,
  Request,
  Site,
  SiteConfigVersion,
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

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "sitepilot-repo-"));
  temporaryDirectories.push(directory);

  return initializeDatabase({
    filePath: join(directory, "sitepilot.sqlite")
  });
}

describe("sqlite repositories", () => {
  it("round-trips workspace and site records", async () => {
    const database = createDatabase();

    try {
      const workspace: Workspace = {
        id: "workspace-1" as Workspace["id"],
        name: "Agency Workspace",
        slug: "agency-workspace",
        ownerUserProfileId: "user-1" as Workspace["ownerUserProfileId"],
        createdAt: now,
        updatedAt: now
      };
      const site: Site = {
        id: "site-1" as Site["id"],
        workspaceId: workspace.id,
        name: "Example Site",
        baseUrl: "https://example.com",
        environment: "production",
        activationStatus: "config_required",
        createdAt: now,
        updatedAt: now
      };

      await database.repositories?.workspaces.save(workspace);
      await database.repositories?.sites.save(site);

      await expect(
        database.repositories?.workspaces.getById(workspace.id)
      ).resolves.toMatchObject({
        name: "Agency Workspace"
      });
      await expect(
        database.repositories?.sites.listByWorkspaceId(workspace.id)
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Example Site" })])
      );
    } finally {
      database.close();
    }
  });

  it("round-trips site config, discovery, thread, request, approval, and audit records", async () => {
    const database = createDatabase();

    try {
      const workspace: Workspace = {
        id: "workspace-1" as Workspace["id"],
        name: "Agency Workspace",
        slug: "agency-workspace",
        ownerUserProfileId: "user-1" as Workspace["ownerUserProfileId"],
        createdAt: now,
        updatedAt: now
      };
      const site: Site = {
        id: "site-1" as Site["id"],
        workspaceId: workspace.id,
        name: "Example Site",
        baseUrl: "https://example.com",
        environment: "production",
        activationStatus: "config_required",
        createdAt: now,
        updatedAt: now
      };
      const config: SiteConfigVersion = {
        id: "config-1" as SiteConfigVersion["id"],
        siteId: site.id,
        version: 1,
        isActive: true,
        summary: "Initial config",
        requiredSectionsComplete: true,
        document: {
          identity: {
            siteName: "Example Site"
          }
        },
        createdAt: now,
        updatedAt: now
      };
      const snapshot: DiscoverySnapshot = {
        id: "discovery-1" as DiscoverySnapshot["id"],
        siteId: site.id,
        revision: 1,
        warnings: ["Plugin missing SEO integration"],
        capabilities: ["content.create"],
        summary: {
          postTypes: ["page", "post"]
        },
        createdAt: now,
        updatedAt: now
      };
      const thread: ChatThread = {
        id: "thread-1" as ChatThread["id"],
        siteId: site.id,
        title: "Homepage edits",
        type: "content_update",
        createdAt: now,
        updatedAt: now
      };
      const request: Request = {
        id: "request-1" as Request["id"],
        siteId: site.id,
        threadId: thread.id,
        requestedBy: {
          userProfileId: "user-1" as Request["requestedBy"]["userProfileId"],
          appRole: "manager",
          siteRoles: ["request"]
        },
        status: "drafted",
        userPrompt: "Update the homepage hero copy.",
        createdAt: now,
        updatedAt: now
      };
      const approval: ApprovalRequest = {
        id: "approval-1" as ApprovalRequest["id"],
        requestId: request.id,
        planId: "plan-1" as ApprovalRequest["planId"],
        siteId: site.id,
        status: "pending",
        requestedBy: request.requestedBy,
        createdAt: now,
        updatedAt: now
      };
      const auditEntry: AuditEntry = {
        id: "audit-1" as AuditEntry["id"],
        siteId: site.id,
        requestId: request.id,
        eventType: "request_created",
        actor: {
          kind: "assistant"
        },
        metadata: {
          source: "test"
        },
        createdAt: now,
        updatedAt: now
      };

      await database.repositories?.workspaces.save(workspace);
      await database.repositories?.sites.save(site);
      await database.repositories?.siteConfigs.save(config);
      await database.repositories?.discoverySnapshots.save(snapshot);
      await database.repositories?.chatThreads.save(thread);
      await database.repositories?.requests.save(request);
      await database.repositories?.approvals.save(approval);
      await database.repositories?.auditEntries.append(auditEntry);

      await expect(
        database.repositories?.siteConfigs.getActiveBySiteId(site.id)
      ).resolves.toMatchObject({ summary: "Initial config" });
      await expect(
        database.repositories?.discoverySnapshots.getLatest(site.id)
      ).resolves.toMatchObject({ revision: 1 });
      await expect(
        database.repositories?.chatThreads.getById(thread.id)
      ).resolves.toMatchObject({ title: "Homepage edits" });
      await expect(
        database.repositories?.requests.listByThreadId(thread.id)
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userPrompt: "Update the homepage hero copy." })
        ])
      );
      await expect(
        database.repositories?.approvals.listPendingBySiteId(site.id)
      ).resolves.toHaveLength(1);
      await expect(
        database.repositories?.auditEntries.listByRequestId(request.id)
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: "request_created" })
        ])
      );
    } finally {
      database.close();
    }
  });
});
