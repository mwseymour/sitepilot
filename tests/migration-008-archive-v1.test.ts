import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openSqliteDatabase,
  runSqliteMigrations,
  sqliteMigrations
} from "@sitepilot/repositories";

const now = "2026-09-29T09:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration 008: archive open v1 requests", () => {
  it("archives open v1 requests, notes why, and leaves everything else alone", () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-migration-008-"));
    temporaryDirectories.push(directory);
    const connection = openSqliteDatabase({ filePath: join(directory, "sitepilot.sqlite") });
    try {
      const before008 = sqliteMigrations.findIndex(
        (migration) => migration.id === "008_archive_open_v1_requests"
      );
      expect(before008).toBeGreaterThan(0);
      runSqliteMigrations(connection, sqliteMigrations.slice(0, before008));

      connection.exec(`
        INSERT INTO workspaces (id, name, slug, owner_user_profile_id, created_at, updated_at)
          VALUES ('w1', 'W', 'w', 'u1', '${now}', '${now}');
        INSERT INTO sites (id, workspace_id, name, base_url, environment, activation_status, created_at, updated_at)
          VALUES ('s1', 'w1', 'Site', 'https://example.com', 'development', 'active', '${now}', '${now}');
        INSERT INTO chat_threads (id, site_id, title, type, created_at, updated_at)
          VALUES ('t1', 's1', 'Thread', 'general_request', '${now}', '${now}');
      `);
      const insertRequest = connection.prepare(
        `INSERT INTO requests (id, site_id, thread_id, requested_by_json, status, user_prompt,
           latest_plan_id, content_engine, created_at, updated_at)
         VALUES (@id, 's1', 't1', '{"kind":"user"}', @status, 'p', @planId, @engine, '${now}', '${now}')`
      );
      const rows = [
        { id: "v1-open", status: "awaiting_approval", planId: "plan-1", engine: "v1" },
        { id: "legacy-open", status: "approved", planId: "plan-2", engine: null },
        { id: "v1-done", status: "completed", planId: "plan-3", engine: "v1" },
        { id: "v2-open", status: "awaiting_approval", planId: null, engine: "gutenberg_v2" },
        { id: "unclaimed-new", status: "new", planId: null, engine: null }
      ];
      for (const row of rows) insertRequest.run(row);

      runSqliteMigrations(connection);

      const statuses = Object.fromEntries(
        connection
          .prepare<[], { id: string; status: string }>("SELECT id, status FROM requests")
          .all()
          .map((row) => [row.id, row.status])
      );
      expect(statuses).toEqual({
        "v1-open": "archived",
        "legacy-open": "archived",
        "v1-done": "completed",
        "v2-open": "awaiting_approval",
        "unclaimed-new": "new"
      });

      const notes = connection
        .prepare<[], { request_id: string; author_json: string; body_json: string }>(
          "SELECT request_id, author_json, body_json FROM chat_messages ORDER BY request_id"
        )
        .all();
      expect(notes.map((note) => note.request_id)).toEqual(["legacy-open", "v1-open"]);
      for (const note of notes) {
        expect(JSON.parse(note.author_json)).toEqual({ kind: "assistant" });
        expect(JSON.parse(note.body_json)).toMatchObject({
          format: "plain_text",
          value: expect.stringContaining("Start a new request")
        });
      }
    } finally {
      connection.close();
    }
  });
});
