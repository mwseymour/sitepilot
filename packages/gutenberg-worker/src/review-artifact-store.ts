import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  GutenbergV2BlockPlan,
  GutenbergV2SourceSnapshot
} from "@sitepilot/contracts";
import { canonicalGutenbergV2Json } from "@sitepilot/services";

import type { GutenbergV2ReviewArtifact } from "@sitepilot/services";

export interface GutenbergV2ReviewArtifactStore {
  write(input: {
    candidateId: string;
    plan: GutenbergV2BlockPlan;
    source?: GutenbergV2SourceSnapshot;
    serializedContent: string;
    serializedContentHash: string;
    capabilityFingerprint: string;
    screenshots: Array<{ viewport: "desktop" | "mobile"; data: Buffer }>;
  }): Promise<GutenbergV2ReviewArtifact>;
}

export class FileGutenbergV2ReviewArtifactStore implements GutenbergV2ReviewArtifactStore {
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0)
      throw new TypeError("A private review artifact directory is required.");
    this.#rootDirectory = resolve(rootDirectory);
  }

  public async write(input: {
    candidateId: string;
    plan: GutenbergV2BlockPlan;
    source?: GutenbergV2SourceSnapshot;
    serializedContent: string;
    serializedContentHash: string;
    capabilityFingerprint: string;
    screenshots: Array<{ viewport: "desktop" | "mobile"; data: Buffer }>;
  }): Promise<GutenbergV2ReviewArtifact> {
    const key = createHash("sha256")
      .update(input.candidateId, "utf8")
      .update("\0")
      .update(input.serializedContentHash, "utf8")
      .digest("hex");
    const directory = join(this.#rootDirectory, key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const structure = `${canonicalGutenbergV2Json({
      schemaVersion: "sitepilot.review-structure/v2",
      candidateId: input.candidateId,
      operation: input.plan.operation,
      before:
        input.source === undefined
          ? null
          : {
              postId: input.source.postId,
              revision: input.source.revision,
              contentHash: input.source.contentHash,
              fields: input.source.fields,
              rawContent: input.source.rawContent,
              blockIndex: input.source.blockIndex
            },
      after: {
        plan: input.plan,
        serializedContent: input.serializedContent,
        serializedContentHash: input.serializedContentHash
      },
      capabilityFingerprint: input.capabilityFingerprint
    })}\n`;
    await this.#writeImmutable(
      join(directory, "structure.json"),
      Buffer.from(structure, "utf8")
    );
    if (input.screenshots.length !== 2) {
      throw new TypeError(
        "Desktop and mobile review screenshots are required."
      );
    }
    const previewRefs: string[] = [];
    for (const screenshot of input.screenshots) {
      const screenshotHash = createHash("sha256")
        .update(screenshot.data)
        .digest("hex");
      const name = `preview-${screenshot.viewport}-${screenshotHash}.png`;
      await this.#writeImmutable(join(directory, name), screenshot.data);
      previewRefs.push(`artifact://gutenberg-v2/${key}/${name}`);
    }
    return {
      structureDiffRef: `artifact://gutenberg-v2/${key}/structure.json`,
      previewRefs
    };
  }

  public async read(reference: string): Promise<Buffer> {
    const match =
      /^artifact:\/\/gutenberg-v2\/([a-f0-9]{64})\/(structure\.json|preview-(?:desktop|mobile)-[a-f0-9]{64}\.png)$/.exec(
        reference
      );
    if (!match) throw new TypeError("Invalid Gutenberg v2 artifact reference.");
    return readFile(join(this.#rootDirectory, match[1]!, match[2]!));
  }

  async #writeImmutable(path: string, data: Buffer): Promise<void> {
    try {
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!existing.equals(data))
        throw new Error(
          "A review artifact reference collided with different immutable content."
        );
    }
  }
}
