import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  gutenbergV2BlockPlanSchema,
  gutenbergV2SeoAfterChanges,
  gutenbergV2SeoChangesSchema,
  gutenbergV2SeoMismatches,
  type GutenbergV2EditorCapabilitySnapshot,
  type GutenbergV2SourceSnapshot
} from "@sitepilot/contracts";
import {
  buildLlmGutenbergV2Plan,
  hashGutenbergV2Content,
  hashGutenbergV2Value
} from "@sitepilot/services";

const content = "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->";
const fields = { title: "Opening hours", excerpt: "", status: "publish" };
const seo = {
  title: "",
  description: "Old description.",
  focusKeyphrase: "",
  canonical: "",
  indexing: "default" as const,
  socialTitle: "",
  socialDescription: ""
};

function capabilities(withSeo: boolean): GutenbergV2EditorCapabilitySnapshot {
  return {
    schemaVersion: "sitepilot.editor-capabilities/v2",
    siteId: "site-1",
    siteUrl: "https://example.test",
    bridgeVersion: "2.0.0",
    wordpressVersion: "7.1.2",
    fingerprint: "1".repeat(64),
    capturedAt: "2026-09-25T12:00:00.000Z",
    context: {
      postType: "post",
      userId: 7,
      userRoles: ["editor"],
      theme: "twentytwentyfive",
      pluginFingerprint: "2".repeat(64),
      editorSettingsFingerprint: "3".repeat(64)
    },
    blocks: [
      {
        name: "core/paragraph",
        registered: true,
        allowed: true,
        v2Support: "author",
        dynamic: false,
        attributeSchemaHash: "4".repeat(64),
        allowedParents: [],
        allowedAncestors: [],
        allowedChildren: [],
        supportsHtml: false,
        lock: "none"
      }
    ],
    ...(withSeo
      ? {
          seo: {
            plugin: "yoast" as const,
            name: "Yoast SEO",
            version: "27.4",
            fields: [
              "title",
              "description",
              "focusKeyphrase",
              "canonical",
              "indexing",
              "socialTitle",
              "socialDescription"
            ]
          }
        }
      : {})
  };
}

function source(): GutenbergV2SourceSnapshot {
  return {
    schemaVersion: "sitepilot.source-snapshot/v2",
    siteId: "site-1",
    postId: 42,
    postType: "post",
    revision: "revision-1",
    rawContent: content,
    contentHash: hashGutenbergV2Content(content),
    fields,
    fieldsHash: hashGutenbergV2Value(fields),
    seo,
    blockTreeFingerprint: "5".repeat(64),
    blockIndex: [
      { path: [0], name: "core/paragraph", fingerprint: "6".repeat(64) }
    ]
  };
}

describe("SEO field contracts", () => {
  it("accepts plain values and Yoast variables", () => {
    expect(() =>
      gutenbergV2SeoChangesSchema.parse({
        title: "%%title%% %%sep%% %%sitename%%",
        description: "Weekday opening times and holiday hours.",
        canonical: "https://example.test/opening-hours/",
        indexing: "noindex"
      })
    ).not.toThrow();
  });

  it("refuses values WordPress would change on save", () => {
    for (const change of [
      { title: "Hello <b>there</b>" },
      { description: "Two\nlines" },
      { description: " padded" },
      { title: "double  space" },
      { canonical: "javascript:alert(1)" },
      { indexing: "nofollow" },
      { ogImage: "https://example.test/a.png" },
      {}
    ]) {
      expect(() => gutenbergV2SeoChangesSchema.parse(change)).toThrow();
    }
  });

  it("allows an SEO-only edit of an existing post", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: "plan-1",
        siteId: "site-1",
        operation: "apply_operations",
        target: {
          postId: 42,
          postType: "post",
          sourceRevision: "revision-1",
          sourceContentHash: hashGutenbergV2Content(content),
          expectedFields: {}
        },
        postFields: { seo: { description: "New." } },
        operations: [],
        media: []
      })
    ).not.toThrow();
  });

  it("hashes SEO values exactly as the plugin does", () => {
    const values = gutenbergV2SeoAfterChanges(undefined, {
      title: "Café — “quoted”"
    });
    // Seo_Adapter::hash() over the same values; see SeoAdapterTest.
    expect(hashGutenbergV2Value(values)).toBe(
      createHash("sha256")
        .update(
          '{"canonical":"","description":"","focusKeyphrase":"","indexing":"default","socialDescription":"","socialTitle":"","title":"Café — “quoted”"}'
        )
        .digest("hex")
    );
  });

  it("reports requested fields that did not persist", () => {
    const after = gutenbergV2SeoAfterChanges(seo, { description: "New." });
    expect(gutenbergV2SeoMismatches({ description: "New." }, after)).toEqual(
      []
    );
    expect(
      gutenbergV2SeoMismatches(
        { description: "New.", indexing: "noindex" },
        after
      )
    ).toEqual(["indexing"]);
    expect(gutenbergV2SeoMismatches({ title: "x" }, undefined)).toEqual([
      "title"
    ]);
  });
});

describe("planning SEO changes", () => {
  function client(draft: unknown) {
    return vi.fn(async () => ({
      text: JSON.stringify(draft),
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
  }

  it("offers SEO fields with the post's current values and keeps an SEO-only edit", async () => {
    const complete = client({
      postFields: {
        seo: {
          description: "  Weekday   opening times.  ",
          indexing: "noindex"
        }
      },
      operations: []
    });
    const result = await buildLlmGutenbergV2Plan({
      request: "Set the meta description and hide it from search.",
      siteId: "site-1",
      target: { operation: "apply_operations", source: source() },
      capabilities: capabilities(true),
      client: { providerId: "test", complete },
      model: "test"
    });
    const [messages] = complete.mock.calls[0] as unknown as [
      Array<{ content: string }>
    ];
    expect(messages[0]!.content).toContain('"seo"?:SeoChanges');
    expect(messages[0]!.content).toContain("SEO (Yoast SEO)");
    expect(JSON.parse(messages[1]!.content).source.seo.description).toBe(
      "Old description."
    );
    if (result.plan.operation !== "apply_operations")
      throw new Error("Expected an update.");
    expect(result.plan.operations).toEqual([]);
    // Whitespace WordPress would collapse is tidied before approval.
    expect(result.plan.postFields?.seo).toEqual({
      description: "Weekday opening times.",
      indexing: "noindex"
    });
  });

  it("does not offer SEO fields without a supported SEO plugin", async () => {
    const complete = client({
      postFields: { title: "T" },
      blocks: [
        {
          ref: "p",
          name: "core/paragraph",
          attributes: { content: "x" },
          children: []
        }
      ]
    });
    await buildLlmGutenbergV2Plan({
      request: "A post.",
      siteId: "site-1",
      target: { operation: "create_draft", postType: "post" },
      capabilities: capabilities(false),
      client: { providerId: "test", complete },
      model: "test"
    });
    const [messages] = complete.mock.calls[0] as unknown as [
      Array<{ content: string }>
    ];
    expect(messages[0]!.content).not.toContain("SeoChanges");
    expect(messages[0]!.content).toContain("never set SEO fields");
  });
});
