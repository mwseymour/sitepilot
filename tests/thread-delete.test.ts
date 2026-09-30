import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Site, SiteId, Workspace } from "@sitepilot/domain";
import { initializeDatabase } from "@sitepilot/repositories";

import {
  createChatThreadForSite,
  createTypedRequestForThread,
  deleteChatThreadForSite
} from "../apps/desktop/src/main/chat-service.js";
import {
  configureRuntimeContext,
  resetRuntimeContext
} from "../apps/desktop/src/main/runtime-context.js";

const now = "2026-09-30T09:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  resetRuntimeContext();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function openSiteDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "sitepilot-thread-delete-"));
  temporaryDirectories.push(directory);
  const database = initializeDatabase({
    filePath: join(directory, "sitepilot.sqlite")
  });
  configureRuntimeContext({ userDataPath: directory, database });
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
    environment: "development",
    activationStatus: "active",
    createdAt: now,
    updatedAt: now
  };
  await database.repositories.workspaces.save(workspace);
  await database.repositories.sites.save(site);
  return { database, siteId: site.id };
}

async function createRequestThread(siteId: SiteId) {
  const thread = await createChatThreadForSite(siteId, {
    title: "Request",
    type: "general_request"
  });
  if (!thread.ok) throw new Error(thread.message);
  const request = await createTypedRequestForThread(
    siteId,
    thread.thread.id,
    "Make a draft"
  );
  if (!request.ok) throw new Error(request.message);
  return { threadId: thread.thread.id, requestId: request.request.id };
}

function count(
  database: Awaited<ReturnType<typeof openSiteDatabase>>["database"],
  table: string
): number {
  return (
    database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

describe("deleteChatThreadForSite", () => {
  it("deletes a thread whose request ran through v2", async () => {
    const { database, siteId } = await openSiteDatabase();
    const { threadId, requestId } = await createRequestThread(siteId);
    database.connection
      .prepare(
        `INSERT INTO gutenberg_v2_request_executions
           (request_id, site_id, execution_id, idempotency_key, target_json, decision, created_at, updated_at)
         VALUES (?, ?, 'exec-1', 'idem-1', '{"operation":"create_draft","postType":"post"}', NULL, ?, ?)`
      )
      .run(requestId, siteId, now, now);

    const result = await deleteChatThreadForSite(siteId, threadId);

    expect(result.ok).toBe(true);
    expect(count(database, "gutenberg_v2_request_executions")).toBe(0);
    expect(count(database, "requests")).toBe(0);
    expect(count(database, "chat_threads")).toBe(0);
  });

  it("deletes a thread whose request has an old reference-image analysis", async () => {
    const { database, siteId } = await openSiteDatabase();
    const { threadId, requestId } = await createRequestThread(siteId);
    database.connection
      .prepare(
        `INSERT INTO request_visual_analyses
           (id, request_id, site_id, provider, model, source_image_count, analyzed_request_updated_at,
            summary, page_type, layout_pattern, style_notes_json, responsive_notes_json, regions_json,
            mapping_warnings_json, created_at, updated_at)
         VALUES ('va-1', ?, ?, 'openai', 'm', 1, ?, 's', 'landing', 'stack', '[]', '[]', '[]', '[]', ?, ?)`
      )
      .run(requestId, siteId, now, now, now);

    const result = await deleteChatThreadForSite(siteId, threadId);

    expect(result.ok).toBe(true);
    expect(count(database, "request_visual_analyses")).toBe(0);
    expect(count(database, "requests")).toBe(0);
  });
});
