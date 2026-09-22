import { describe, expect, it } from "vitest";

import {
  GUTENBERG_V2_LIMITS,
  GUTENBERG_V2_SUPPORT_MATRIX,
  gutenbergV2BlockPlanSchema,
  gutenbergV2CommitReceiptSchema,
  gutenbergV2EditorPreviewRequestSchema,
  gutenbergV2MediaBindingsRequestSchema,
  gutenbergV2ValidationReportSchema
} from "@sitepilot/contracts";
import {
  canonicalGutenbergV2Json,
  hashGutenbergV2Value
} from "@sitepilot/services";

const hash = "a".repeat(64);

function validPlan() {
  return {
    schemaVersion: "sitepilot.block-plan/v2" as const,
    planId: "plan-1",
    siteId: "site-1",
    operation: "create_draft" as const,
    target: { postType: "post" as const },
    postFields: { title: "A safe draft", status: "draft" as const },
    blocks: [
      {
        ref: "intro",
        name: "core/paragraph" as const,
        attributes: { content: "Read <strong>this</strong>." },
        children: []
      }
    ],
    media: []
  };
}

describe("Gutenberg v2 contracts", () => {
  it("accepts the explicit create-draft contract and release matrix", () => {
    const parsed = gutenbergV2BlockPlanSchema.parse(validPlan());
    expect(parsed.operation).toBe("create_draft");
    expect(
      GUTENBERG_V2_SUPPORT_MATRIX.find(
        (entry) => entry.name === "core/latest-posts"
      )?.mode
    ).toBe("fixture_required");
  });

  it("fails closed on wrapper markup, unknown attributes, and unsupported blocks", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...validPlan(),
        blocks: [{ ...validPlan().blocks[0], innerHTML: "<p>bad</p>" }]
      })
    ).toThrow();
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...validPlan(),
        blocks: [
          {
            ...validPlan().blocks[0],
            attributes: { content: "Text", madeUpAttribute: true }
          }
        ]
      })
    ).toThrow();
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...validPlan(),
        blocks: [
          {
            ref: "html",
            name: "core/html",
            attributes: { content: "<p>x</p>" },
            children: []
          }
        ]
      })
    ).toThrow();
  });

  it("rejects unsafe encoded links and unreviewed rich-text attributes", () => {
    for (const content of [
      '<a href="java&#x73;cript:alert(1)">bad</a>',
      '<strong style="color:red">bad</strong>',
      "<a href=https://example.com>unquoted</a>"
    ]) {
      expect(() =>
        gutenbergV2BlockPlanSchema.parse({
          ...validPlan(),
          blocks: [{ ...validPlan().blocks[0], attributes: { content } }]
        })
      ).toThrow();
    }
  });

  it("rejects a caption that has no explicit image representation", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        ...validPlan(),
        blocks: [
          {
            ref: "media-text",
            name: "core/media-text",
            attributes: {
              mediaRef: "hero",
              mediaAlt: "Approved alt",
              mediaPosition: "left"
            },
            children: []
          }
        ],
        media: [
          {
            ref: "hero",
            source: {
              kind: "library_attachment",
              attachmentId: 42,
              checksum: hash
            },
            alt: "Approved alt",
            caption: "This caption has nowhere to render."
          }
        ]
      })
    ).toThrow(/caption requires an explicit core\/image/i);
  });

  it("preflights pathological depth before recursive parsing", () => {
    const plan = validPlan() as Record<string, any>;
    let node: Record<string, any> = {
      ref: "root",
      name: "core/group",
      attributes: {},
      children: []
    };
    plan.blocks = [node];
    for (
      let index = 0;
      index < GUTENBERG_V2_LIMITS.maxDepth + 2_000;
      index += 1
    ) {
      const child = {
        ref: `node-${index}`,
        name: "core/group",
        attributes: {},
        children: []
      };
      node.children = [child];
      node = child;
    }
    const result = gutenbergV2BlockPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((entry) => entry.message.includes("nesting"))
      ).toBe(true);
    }
  });

  it("fails closed without throwing for cyclic raw input", () => {
    const plan = validPlan() as Record<string, any>;
    const block = {
      ref: "cycle",
      name: "core/group",
      attributes: {},
      children: [] as unknown[]
    };
    block.children.push(block);
    plan.blocks = [block];

    expect(() => gutenbergV2BlockPlanSchema.safeParse(plan)).not.toThrow();
    const result = gutenbergV2BlockPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((entry) =>
          entry.message.includes("JSON serializable")
        )
      ).toBe(true);
    }
  });

  it("requires validation inventory, semantic hashes, and every preservation dimension", () => {
    const base = {
      outcome: "valid" as const,
      expectedBlockCount: 1,
      observedBlockCount: 1,
      issues: [],
      contentPreservation: {
        passed: true,
        checked: [
          "text",
          "inline_markup",
          "links",
          "media",
          "captions",
          "ordering",
          "layout",
          "post_fields"
        ] as const,
        intentHash: hash,
        observedIntentHash: hash
      }
    };
    expect(gutenbergV2ValidationReportSchema.parse(base).outcome).toBe("valid");
    expect(() =>
      gutenbergV2ValidationReportSchema.parse({
        ...base,
        observedBlockCount: 0
      })
    ).toThrow();
    expect(() =>
      gutenbergV2ValidationReportSchema.parse({
        ...base,
        contentPreservation: {
          ...base.contentPreservation,
          observedIntentHash: "b".repeat(64)
        }
      })
    ).toThrow();
    expect(() =>
      gutenbergV2ValidationReportSchema.parse({
        ...base,
        contentPreservation: { ...base.contentPreservation, checked: ["text"] }
      })
    ).toThrow();
  });

  it("keeps commit receipts strict and versioned", () => {
    const receipt = {
      schemaVersion: "sitepilot.commit-receipt/v2" as const,
      executionId: "execution-1",
      idempotencyKey: "key-1",
      preparedCommitId: "prepared-1",
      disposition: "applied" as const,
      postId: 42,
      persistedRevision: "revision-2",
      persistedContentHash: hash,
      persistedFieldsHash: hash,
      beforeStateRef: "before-1",
      committedAt: "2026-09-22T12:00:00.000Z"
    };
    expect(gutenbergV2CommitReceiptSchema.parse(receipt).postId).toBe(42);
    expect(() =>
      gutenbergV2CommitReceiptSchema.parse({ ...receipt, legacyFallback: true })
    ).toThrow();
  });

  it("bounds private preview bytes and keeps library attachment metadata read-only", () => {
    expect(() =>
      gutenbergV2EditorPreviewRequestSchema.parse({
        serializedContent:
          "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->",
        intent: validPlan(),
        viewport: "desktop",
        previewMediaMapping: [
          {
            ref: "hero",
            approvedChecksum: hash,
            dataUrl: "data:text/html;base64,PHNjcmlwdD4="
          }
        ]
      })
    ).toThrow();
    expect(() =>
      gutenbergV2MediaBindingsRequestSchema.parse({
        schemaVersion: "sitepilot.media-bindings-request/v2",
        executionId: "execution-1",
        idempotencyKey: "key-1",
        siteId: "site-1",
        items: [
          {
            ref: "existing",
            bindingId: hash,
            approvedChecksum: hash,
            kind: "library_attachment",
            attachmentId: 42,
            alt: "Must not mutate existing attachment metadata"
          }
        ]
      })
    ).toThrow();
  });

  it("uses stable UTF-16 key ordering and JSON number encoding for cross-runtime hashes", () => {
    const value = {
      z: [1.25, -0, true, null],
      a: { é: "café", empty: {} },
      A: "first"
    };
    expect(canonicalGutenbergV2Json(value)).toBe(
      '{"A":"first","a":{"empty":{},"é":"café"},"z":[1.25,0,true,null]}'
    );
    expect(hashGutenbergV2Value(value)).toBe(
      "7b627979703fcb1eaa6d52bc108179cadd7da714e8bf0bf2c80fc87356687e53"
    );
  });
});
