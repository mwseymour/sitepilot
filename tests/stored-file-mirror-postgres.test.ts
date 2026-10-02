import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileGutenbergV2ReviewArtifactStore } from "@sitepilot/gutenberg-worker";
import { initializePostgresDatabase } from "@sitepilot/repositories";
import {
  FileGutenbergV2StagedAssetStore,
  SqlStoredFileMirror,
  pruneStoredFiles
} from "@sitepilot/services";

import {
  TEST_POSTGRES_URL,
  createTestPostgresDatabase
} from "./postgres-test-database.js";

/**
 * The hosted server's disk is lost on every deploy. Review files and staged
 * media written through the database mirror can still be read afterwards.
 */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "sitepilot-mirror-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function database() {
  const created = await createTestPostgresDatabase();
  cleanups.push(created.drop);
  const opened = await initializePostgresDatabase({ connectionString: created.url, max: 2 });
  cleanups.push(opened.close);
  return opened.sql;
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not really an image, but the header is right")
]);

describe.skipIf(!TEST_POSTGRES_URL)("Postgres file mirror", () => {
  it("reads review files back after the disk is gone", async () => {
    const sql = await database();
    const mirror = new SqlStoredFileMirror(sql, "review/site-1");
    const written = await new FileGutenbergV2ReviewArtifactStore(directory(), mirror).write({
      candidateId: "candidate-1",
      plan: { operation: "create_draft" } as never,
      serializedContent: "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->",
      serializedContentHash: "a".repeat(64),
      capabilityFingerprint: "b".repeat(64),
      screenshots: [
        { viewport: "desktop", data: PNG },
        { viewport: "mobile", data: Buffer.concat([PNG, Buffer.from("mobile")]) }
      ]
    });

    // A new container: an empty directory, the same database.
    const fresh = new FileGutenbergV2ReviewArtifactStore(directory(), mirror);
    expect(await fresh.read(written.previewRefs[0]!)).toEqual(PNG);
    expect((await fresh.read(written.structureDiffRef)).toString("utf8")).toContain("candidate-1");

    // Without the mirror, or for another site, the file is simply missing.
    await expect(new FileGutenbergV2ReviewArtifactStore(directory()).read(written.previewRefs[0]!)).rejects.toThrow(
      /ENOENT/
    );
    await expect(
      new FileGutenbergV2ReviewArtifactStore(directory(), new SqlStoredFileMirror(sql, "review/site-2")).read(
        written.previewRefs[0]!
      )
    ).rejects.toThrow(/ENOENT/);
  });

  it("reads staged media back after the disk is gone, still checked against its checksum", async () => {
    const sql = await database();
    const mirror = new SqlStoredFileMirror(sql, "staged-media/site-1");
    const staged = await new FileGutenbergV2StagedAssetStore(directory(), mirror).stage({
      bytes: PNG,
      mediaType: "image/png"
    });
    expect(await new FileGutenbergV2StagedAssetStore(directory(), mirror).read(staged)).toEqual(PNG);
    await expect(
      new FileGutenbergV2StagedAssetStore(directory(), mirror).read({ ...staged, checksum: "c".repeat(64) })
    ).rejects.toThrow();
  });

  it("prunes files older than the cutoff and keeps newer ones", async () => {
    const sql = await database();
    const mirror = new SqlStoredFileMirror(sql, "review/site-1");
    await mirror.put("old.png", PNG);
    await mirror.put("new.png", PNG);
    await sql
      .prepare(`UPDATE stored_files SET created_at = @createdAt WHERE key = @key`)
      .run({ createdAt: "2026-01-01T00:00:00.000Z", key: "review/site-1/old.png" });

    expect(await pruneStoredFiles(sql, new Date("2026-06-01T00:00:00.000Z"))).toBe(1);
    expect(await mirror.get("old.png")).toBeNull();
    expect(await mirror.get("new.png")).toEqual(PNG);
  });
});
