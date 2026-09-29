import { describe, expect, it, vi } from "vitest";

import type { GutenbergV2EditorCapabilitySnapshot } from "@sitepilot/contracts";
import { buildLlmGutenbergV2Plan } from "@sitepilot/services";

function block(name: string) {
  return {
    name,
    registered: true,
    allowed: true,
    v2Support: "author" as const,
    dynamic: false,
    attributeSchemaHash: "4".repeat(64),
    allowedParents: [],
    allowedAncestors: [],
    allowedChildren: [],
    supportsHtml: false,
    lock: "none" as const
  };
}

const capabilities: GutenbergV2EditorCapabilitySnapshot = {
  schemaVersion: "sitepilot.editor-capabilities/v2",
  siteId: "site-1",
  siteUrl: "https://example.test",
  bridgeVersion: "2.0.0",
  wordpressVersion: "7.1.2",
  fingerprint: "1".repeat(64),
  capturedAt: "2026-09-29T12:00:00.000Z",
  context: {
    postType: "post",
    userId: 7,
    userRoles: ["editor"],
    theme: "twentytwentyfive",
    pluginFingerprint: "2".repeat(64),
    editorSettingsFingerprint: "3".repeat(64)
  },
  blocks: [
    block("core/paragraph"),
    block("core/heading"),
    block("core/cover"),
    block("core/image")
  ]
};

function responses(...drafts: unknown[]) {
  const complete = vi.fn();
  for (const draft of drafts) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify(draft),
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
  return complete;
}

function plan(complete: ReturnType<typeof vi.fn>) {
  return buildLlmGutenbergV2Plan({
    request: "A post.",
    siteId: "site-1",
    target: { operation: "create_draft", postType: "post" },
    capabilities,
    client: { providerId: "test", complete },
    model: "test"
  });
}

describe("Gutenberg v2 plan generator", () => {
  it("reads a block written without a child list as having no children", async () => {
    const complete = responses({
      postFields: { title: "T" },
      blocks: [
        { ref: "h", name: "core/heading", attributes: { content: "Hi", level: 2 } },
        { ref: "p", name: "core/paragraph", attributes: { content: "x" } }
      ]
    });
    const result = await plan(complete);
    expect(complete).toHaveBeenCalledTimes(1);
    if (result.plan.operation !== "create_draft") throw new Error("Expected a draft.");
    expect(result.plan.blocks.map((node) => node.children)).toEqual([[], []]);
  });

  it("reads CSS shorthand padding and margin as sides", async () => {
    const paragraph = (ref: string, spacing: unknown) => ({
      ref,
      name: "core/paragraph",
      attributes: { content: "x", style: { spacing } },
      children: []
    });
    const complete = responses({
      postFields: { title: "T" },
      blocks: [
        paragraph("a", { padding: "1.5rem" }),
        paragraph("b", { padding: "0.75rem 1.25rem", margin: 8 })
      ]
    });
    const result = await plan(complete);
    expect(complete).toHaveBeenCalledTimes(1);
    if (result.plan.operation !== "create_draft") throw new Error("Expected a draft.");
    expect(result.plan.blocks.map((node) => node.attributes.style)).toEqual([
      {
        spacing: {
          padding: { top: "1.5rem", right: "1.5rem", bottom: "1.5rem", left: "1.5rem" }
        }
      },
      {
        spacing: {
          padding: { top: "0.75rem", right: "1.25rem", bottom: "0.75rem", left: "1.25rem" },
          margin: { top: "8px", right: "8px", bottom: "8px", left: "8px" }
        }
      }
    ]);
  });

  it("reads an image's mediaAlt as its alt text", async () => {
    const complete = responses({
      postFields: { title: "T" },
      blocks: [
        {
          ref: "img",
          name: "core/image",
          attributes: { mediaRef: "photo", mediaAlt: "A fell" },
          children: []
        }
      ]
    });
    const result = await buildLlmGutenbergV2Plan({
      request: "A post.",
      siteId: "site-1",
      target: { operation: "create_draft", postType: "post" },
      capabilities,
      media: [
        {
          ref: "photo",
          source: {
            kind: "staged_asset",
            stagedAssetId: "staged-1",
            checksum: "5".repeat(64),
            mediaType: "image/jpeg",
            byteLength: 10
          },
          alt: "A fell"
        }
      ],
      client: { providerId: "test", complete },
      model: "test"
    });
    expect(complete).toHaveBeenCalledTimes(1);
    if (result.plan.operation !== "create_draft") throw new Error("Expected a draft.");
    expect(result.plan.blocks[0]!.attributes).toEqual({ mediaRef: "photo", alt: "A fell" });
  });

  it("drops a zero cover minimum height", async () => {
    const complete = responses({
      postFields: { title: "T" },
      blocks: [
        {
          ref: "cover",
          name: "core/cover",
          attributes: { customOverlayColor: "#1F3B2D", minHeight: 0, minHeightUnit: "px" },
          children: [
            { ref: "h", name: "core/heading", attributes: { content: "Hi", level: 1 }, children: [] }
          ]
        }
      ]
    });
    const result = await plan(complete);
    expect(complete).toHaveBeenCalledTimes(1);
    if (result.plan.operation !== "create_draft") throw new Error("Expected a draft.");
    expect(result.plan.blocks[0]!.attributes).toEqual({ customOverlayColor: "#1F3B2D" });
  });

  it("renames a block ref the model repeats", async () => {
    const complete = responses({
      postFields: { title: "T" },
      blocks: [
        { ref: "p", name: "core/paragraph", attributes: { content: "a" }, children: [] },
        { ref: "p", name: "core/paragraph", attributes: { content: "b" }, children: [] },
        { ref: "p-2", name: "core/paragraph", attributes: { content: "c" }, children: [] }
      ]
    });
    const result = await plan(complete);
    expect(complete).toHaveBeenCalledTimes(1);
    if (result.plan.operation !== "create_draft") throw new Error("Expected a draft.");
    expect(result.plan.blocks.map((node) => node.ref)).toEqual(["p", "p-2", "p-2-2"]);
  });

  it("restates a block's attribute rules when repairing an attribute issue", async () => {
    const heading = {
      ref: "h",
      name: "core/heading",
      attributes: { content: "Hi", level: 1 },
      children: []
    };
    const complete = responses(
      {
        postFields: { title: "T" },
        blocks: [
          {
            ref: "cover",
            name: "core/cover",
            attributes: { backgroundColor: "#1F3B2D", dimRatio: 80 },
            children: [heading]
          }
        ]
      },
      {
        postFields: { title: "T" },
        blocks: [
          {
            ref: "cover",
            name: "core/cover",
            attributes: { customOverlayColor: "#1F3B2D", dimRatio: 80 },
            children: [heading]
          }
        ]
      }
    );
    const result = await plan(complete);
    expect(complete).toHaveBeenCalledTimes(2);
    const [messages] = complete.mock.calls[1] as unknown as [
      Array<{ content: string }>
    ];
    expect(messages[1]!.content).toContain("'backgroundColor'");
    expect(messages[1]!.content).toContain("core/cover accepts only:");
    expect(messages[1]!.content).toContain("customOverlayColor:#hex");
    if (result.plan.operation !== "create_draft") throw new Error("Expected a draft.");
    expect(result.plan.blocks[0]!.attributes).toMatchObject({
      customOverlayColor: "#1F3B2D"
    });
  });
});
