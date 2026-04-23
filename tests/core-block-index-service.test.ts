import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildWordPressCoreBlockIndex,
  defaultWordPressCoreIndexCachePath,
  reindexWordPressCoreBlockIndex
} from "../apps/desktop/src/main/core-block-index-service.js";

const tempDirs: string[] = [];

async function makeSnapshotFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sitepilot-wp-core-"));
  tempDirs.push(root);

  await mkdir(path.join(root, "wp-includes", "blocks", "paragraph"), {
    recursive: true
  });
  await mkdir(path.join(root, "wp-includes", "blocks", "quote"), {
    recursive: true
  });

  await writeFile(
    path.join(root, "wp-includes", "version.php"),
    "<?php\n$wp_version = '6.9-alpha';\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "wp-includes", "blocks", "paragraph", "block.json"),
    JSON.stringify(
      {
        name: "core/paragraph",
        title: "Paragraph",
        category: "text",
        apiVersion: 3,
        attributes: {
          align: { type: "string" }
        },
        supports: {
          color: true
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(root, "wp-includes", "blocks", "quote", "block.json"),
    JSON.stringify(
      {
        name: "core/quote",
        title: "Quote",
        category: "text",
        parent: ["core/group"],
        allowedBlocks: ["core/paragraph", "core/cite"],
        render: "file:./render.php"
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(root, "wp-includes", "blocks", "quote", "render.php"),
    "<?php\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "wp-includes", "blocks", "quote.php"),
    "<?php\n",
    "utf8"
  );

  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("core block index service", () => {
  it("indexes block metadata from a local wordpress-core snapshot", async () => {
    const root = await makeSnapshotFixture();

    const index = await buildWordPressCoreBlockIndex(root);

    expect(index).not.toBeNull();
    expect(index?.wordpressVersion).toBe("6.9-alpha");
    expect(index?.indexedBlockCount).toBe(2);
    expect(index?.executableBlockCount).toBe(2);
    expect(index?.blocks[0]?.name).toBe("core/paragraph");
    expect(index?.blocks[0]?.executable).toBe(true);
    expect(index?.blocks[1]?.name).toBe("core/quote");
    expect(index?.blocks[1]?.renderPath).toBe(
      "wp-includes/blocks/quote/render.php"
    );
    expect(index?.blocks[1]?.phpRegistrationPath).toBe(
      "wp-includes/blocks/quote.php"
    );
  });

  it("writes a cache file when reindexing", async () => {
    const root = await makeSnapshotFixture();

    const index = await reindexWordPressCoreBlockIndex(root);
    const cachePath = defaultWordPressCoreIndexCachePath(root);
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      indexedBlockCount: number;
    };

    expect(index).not.toBeNull();
    expect(cached.indexedBlockCount).toBe(2);
  });
});
