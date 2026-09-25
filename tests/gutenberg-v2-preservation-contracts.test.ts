import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GUTENBERG_V2_SOURCE_BLOCK,
  gutenbergV2BlockManifest,
  gutenbergV2BlockPlanSchema
} from "@sitepilot/contracts";

const hash = "a".repeat(64);

function existingTarget() {
  return {
    postId: 42,
    postType: "post" as const,
    sourceRevision: "revision-1",
    sourceContentHash: hash,
    expectedFields: {}
  };
}

function base(operation: "replace_content" | "apply_operations") {
  return {
    schemaVersion: "sitepilot.block-plan/v2" as const,
    planId: "plan-1",
    siteId: "site-1",
    operation,
    target: existingTarget(),
    media: []
  };
}

const paragraph = {
  ref: "p-1",
  name: "core/paragraph" as const,
  attributes: { content: "New copy" },
  children: []
};

function kept(ref: string, path: number[]) {
  return {
    ref,
    name: GUTENBERG_V2_SOURCE_BLOCK,
    attributes: { path, expectedFingerprint: hash },
    children: []
  };
}

describe("Gutenberg v2 kept source blocks", () => {
  it("lets a replacement keep source blocks, top level or nested", () => {
    const plan = gutenbergV2BlockPlanSchema.parse({
      ...base("replace_content"),
      blocks: [
        kept("keep-cover", [0]),
        {
          ref: "group",
          name: "core/group",
          attributes: {},
          children: [paragraph, kept("keep-embed", [2, 1])]
        }
      ],
      removedSourceBlocks: [{ path: [1], expectedFingerprint: hash }]
    });
    expect(plan.operation).toBe("replace_content");
  });

  it("rejects kept blocks in a new draft, twice-kept blocks and kept children", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: "plan-1",
        siteId: "site-1",
        operation: "create_draft",
        target: { postType: "post" },
        postFields: { title: "Draft", status: "draft" },
        blocks: [kept("keep", [0])],
        media: []
      })
    ).toThrow(/no source blocks/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...base("replace_content"),
        blocks: [kept("a", [0]), kept("b", [0])]
      })
    ).toThrow(/only be kept once/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...base("replace_content"),
        blocks: [{ ...kept("a", [0]), children: [paragraph] }]
      })
    ).toThrow();
  });

  it("accepts move_block and rejects touching one source block twice", () => {
    const move = {
      id: "move-1",
      type: "move_block" as const,
      target: { path: [3], expectedFingerprint: hash },
      parent: { path: [], expectedFingerprint: hash },
      index: 0
    };
    expect(
      gutenbergV2BlockPlanSchema.parse({
        ...base("apply_operations"),
        operations: [move]
      }).operation
    ).toBe("apply_operations");
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...base("apply_operations"),
        operations: [
          move,
          {
            id: "remove-1",
            type: "remove_block",
            target: { path: [3], expectedFingerprint: hash }
          }
        ]
      })
    ).toThrow(/only once/);
  });

  it("enforces matrix parent rules at the root", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...base("replace_content"),
        blocks: [
          {
            ref: "col",
            name: "core/column",
            attributes: {},
            children: [paragraph]
          }
        ]
      })
    ).toThrow(/core\/columns/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...base("apply_operations"),
        operations: [
          {
            id: "insert-1",
            type: "insert_blocks",
            parent: { path: [], expectedFingerprint: hash },
            index: 0,
            blocks: [
              {
                ref: "item",
                name: "core/list-item",
                attributes: { content: "Item" },
                children: []
              }
            ]
          }
        ]
      })
    ).toThrow(/core\/list/);
  });
});

describe("Gutenberg v2 block manifest", () => {
  it("matches the file the WordPress plugin reads", () => {
    const file = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "plugins/wordpress-sitepilot/includes/V2/block-manifest.json"
        ),
        "utf8"
      )
    ) as unknown;
    expect(file).toEqual(gutenbergV2BlockManifest());
  });
});

describe("Gutenberg v2 blocks added after the first release", () => {
  function draft(blocks: unknown[], media: unknown[] = []) {
    return {
      schemaVersion: "sitepilot.block-plan/v2" as const,
      planId: "plan-1",
      siteId: "site-1",
      operation: "create_draft" as const,
      target: { postType: "post" as const },
      postFields: { title: "Draft", status: "draft" as const },
      blocks,
      media
    };
  }
  const media = {
    ref: "img",
    source: { kind: "library_attachment", attachmentId: 5, checksum: hash },
    alt: "Alt"
  };
  const embed = (url: string, providerNameSlug = "youtube") => ({
    ref: "embed",
    name: "core/embed",
    attributes: { url, providerNameSlug, type: "video", responsive: true },
    children: []
  });

  it("embeds only YouTube and Vimeo video URLs with a matching provider", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ"
    ]) {
      expect(() => gutenbergV2BlockPlanSchema.parse(draft([embed(url)]))).not.toThrow();
    }
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([embed("https://vimeo.com/76979871", "vimeo")])
      )
    ).not.toThrow();
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(draft([embed("https://example.com/video")]))
    ).toThrow(/YouTube and Vimeo/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([embed("https://vimeo.com/76979871", "youtube")])
      )
    ).toThrow(/vimeo video/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([embed("javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ")])
      )
    ).toThrow();
  });

  it("requires a cover background and content, and galleries of images", () => {
    const heading = {
      ref: "h",
      name: "core/heading",
      attributes: { content: "Hi", level: 2 },
      children: []
    };
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft(
          [
            {
              ref: "cover",
              name: "core/cover",
              attributes: { mediaRef: "img", alt: "", dimRatio: 50 },
              children: [heading]
            }
          ],
          [media]
        )
      )
    ).not.toThrow();
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([{ ref: "cover", name: "core/cover", attributes: {}, children: [heading] }])
      )
    ).toThrow(/background/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([
          {
            ref: "cover",
            name: "core/cover",
            attributes: { customOverlayColor: "#123456" },
            children: []
          }
        ])
      )
    ).toThrow(/at least one child/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([
          {
            ref: "gallery",
            name: "core/gallery",
            attributes: {},
            children: [heading]
          }
        ])
      )
    ).toThrow(/unsupported child/);
  });

  it("keeps separators to their reviewed styles", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([
          {
            ref: "sep",
            name: "core/separator",
            attributes: { className: "is-style-dots" },
            children: []
          }
        ])
      )
    ).not.toThrow();
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft([
          {
            ref: "sep",
            name: "core/separator",
            attributes: { style: { color: { background: "red" } } },
            children: []
          }
        ])
      )
    ).toThrow();
  });
});
