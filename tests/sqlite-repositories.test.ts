import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalRequest,
  AuditEntry,
  ChatMessage,
  ChatThread,
  ClarificationRound,
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
        expect.arrayContaining([
          expect.objectContaining({ name: "Example Site" })
        ])
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
      database.connection
        .prepare(
          `INSERT INTO action_plans (
             id, request_id, site_id, summary, assumptions_json, open_questions_json,
             approval_required, risk_level, target_entity_refs_json, created_at, updated_at
           ) VALUES (
             @id, @requestId, @siteId, @summary, @assumptionsJson, @openQuestionsJson,
             @approvalRequired, @riskLevel, @targetEntityRefsJson, @createdAt, @updatedAt
           )`
        )
        .run({
          id: "plan-1",
          requestId: request.id,
          siteId: site.id,
          summary: "Review homepage changes",
          assumptionsJson: JSON.stringify([]),
          openQuestionsJson: JSON.stringify([]),
          approvalRequired: 1,
          riskLevel: "medium",
          targetEntityRefsJson: JSON.stringify(["site:site-1"]),
          createdAt: now,
          updatedAt: now
        });
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
          expect.objectContaining({
            userPrompt: "Update the homepage hero copy."
          })
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

  it("round-trips chat messages and clarification rounds", async () => {
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
      const thread: ChatThread = {
        id: "thread-1" as ChatThread["id"],
        siteId: site.id,
        title: "Chat",
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
        userPrompt: "Do something.",
        createdAt: now,
        updatedAt: now
      };
      const message: ChatMessage = {
        id: "msg-1" as ChatMessage["id"],
        threadId: thread.id,
        siteId: site.id,
        author: { kind: "assistant" },
        body: { format: "plain_text", value: "Clarification needed." },
        requestId: request.id,
        createdAt: now,
        updatedAt: now
      };
      const round: ClarificationRound = {
        id: "round-1" as ClarificationRound["id"],
        requestId: request.id,
        siteId: site.id,
        questions: ["Which page?"],
        answers: [],
        createdAt: now,
        updatedAt: now
      };

      await database.repositories?.workspaces.save(workspace);
      await database.repositories?.sites.save(site);
      await database.repositories?.chatThreads.save(thread);
      await database.repositories?.requests.save(request);
      await database.repositories?.chatMessages.save(message);
      await database.repositories?.clarificationRounds.save(round);

      await expect(
        database.repositories?.chatMessages.listByThreadId(thread.id)
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: { format: "plain_text", value: "Clarification needed." },
            requestId: request.id
          })
        ])
      );
      await expect(
        database.repositories?.clarificationRounds.listByRequestId(request.id)
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            questions: ["Which page?"],
            answers: []
          })
        ])
      );
    } finally {
      database.close();
    }
  });

  it("deletes chat threads by id", async () => {
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
        activationStatus: "active",
        createdAt: now,
        updatedAt: now
      };
      const thread: ChatThread = {
        id: "thread-1" as ChatThread["id"],
        siteId: site.id,
        title: "Delete me",
        type: "general_request",
        createdAt: now,
        updatedAt: now
      };

      await database.repositories?.workspaces.save(workspace);
      await database.repositories?.sites.save(site);
      await database.repositories?.chatThreads.save(thread);

      await database.repositories?.chatThreads.deleteById(thread.id);

      await expect(
        database.repositories?.chatThreads.getById(thread.id)
      ).resolves.toBeNull();
    } finally {
      database.close();
    }
  });
});
