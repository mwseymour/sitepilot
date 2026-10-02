import { describe, expect, it, vi } from "vitest";

import {
  gutenbergV2TermChangesSchema,
  gutenbergV2TermMismatches,
  type GutenbergV2EditorCapabilitySnapshot,
  type GutenbergV2SourceSnapshot
} from "@sitepilot/contracts";
import {
  buildLlmGutenbergV2Plan,
  GutenbergV2PlanClarification,
  GutenbergV2PlanGenerationError,
  hashGutenbergV2Content,
  hashGutenbergV2Value
} from "@sitepilot/services";

const content = "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->";
const fields = { title: "Lake walks", excerpt: "", status: "draft" };
const availableTerms = {
  category: [
    { id: 1, name: "Uncategorized" },
    { id: 3, name: "News & views" },
    { id: 4, name: "Travel" }
  ],
  post_tag: [
    { id: 9, name: "Walking" },
    { id: 10, name: "Lakes" }
  ]
};

function capabilities(withTerms: boolean): GutenbergV2EditorCapabilitySnapshot {
  return {
    schemaVersion: "sitepilot.editor-capabilities/v2",
    siteId: "site-1",
    siteUrl: "https://example.test",
    bridgeVersion: "2.0.0",
    wordpressVersion: "7.1.2",
    fingerprint: "1".repeat(64),
    capturedAt: "2026-10-02T12:00:00.000Z",
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
    ...(withTerms ? { terms: { taxonomies: ["category", "post_tag"] as Array<"category" | "post_tag"> } } : {})
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
    terms: { category: [{ id: 3, name: "News & views" }], post_tag: [{ id: 9, name: "Walking" }] },
    blockTreeFingerprint: "5".repeat(64),
    blockIndex: [{ path: [0], name: "core/paragraph", fingerprint: "6".repeat(64) }]
  };
}

function client(...drafts: unknown[]) {
  const complete = vi.fn();
  for (const draft of drafts) {
    complete.mockResolvedValueOnce({ text: JSON.stringify(draft), usage: { inputTokens: 1, outputTokens: 1 } });
  }
  return complete;
}

function plan(complete: ReturnType<typeof client>, withTerms = true) {
  return buildLlmGutenbergV2Plan({
    request: "Tag it with lakes and move it to Travel.",
    siteId: "site-1",
    target: { operation: "apply_operations", source: source() },
    capabilities: capabilities(withTerms),
    availableTerms,
    client: { providerId: "test", complete },
    model: "test"
  });
}

describe("category and tag contracts", () => {
  it("needs at least one taxonomy, and a category on every post", () => {
    expect(gutenbergV2TermChangesSchema.safeParse({ post_tag: [] }).success).toBe(true);
    expect(gutenbergV2TermChangesSchema.safeParse({}).success).toBe(false);
    expect(gutenbergV2TermChangesSchema.safeParse({ category: [] }).success).toBe(false);
    expect(gutenbergV2TermChangesSchema.safeParse({ nav_menu: [{ id: 1, name: "x" }] }).success).toBe(false);
  });

  it("compares persisted terms by ID", () => {
    const changes = { post_tag: [{ id: 10, name: "Lakes" }, { id: 9, name: "Walking" }] };
    expect(gutenbergV2TermMismatches(changes, { category: [], post_tag: [{ id: 9, name: "W" }, { id: 10, name: "L" }] })).toEqual([]);
    expect(gutenbergV2TermMismatches(changes, { category: [], post_tag: [{ id: 9, name: "W" }] })).toEqual(["post_tag"]);
  });
});

describe("planning categories and tags", () => {
  it("matches names to existing terms and works out the final sets", async () => {
    const complete = client({
      postFields: { terms: { post_tag: { add: ["lakes"] }, category: { set: ["TRAVEL"] } } },
      operations: []
    });
    const result = await plan(complete);

    const [messages] = complete.mock.calls[0] as unknown as [Array<{ content: string }>];
    expect(messages[0]!.content).toContain('"terms"?:TermChanges');
    const context = JSON.parse(messages[1]!.content);
    expect(context.availableTerms.post_tag).toEqual(["Walking", "Lakes"]);
    expect(context.source.terms).toEqual({ category: ["News & views"], post_tag: ["Walking"] });
    if (result.plan.operation !== "apply_operations") throw new Error("Expected an update.");
    expect(result.plan.operations).toEqual([]);
    expect(result.plan.postFields?.terms).toEqual({
      category: [{ id: 4, name: "Travel" }],
      post_tag: [
        { id: 9, name: "Walking" },
        { id: 10, name: "Lakes" }
      ]
    });
  });

  it("creates a new term only when named under create, and never duplicates one", async () => {
    const complete = client({
      postFields: { terms: { post_tag: { create: ["Mountains", "lakes", "mountains "] } } },
      operations: []
    });
    const result = await plan(complete);
    if (result.plan.operation !== "apply_operations") throw new Error("Expected an update.");
    // "lakes" is the existing Lakes tag; "Mountains" is new, once.
    expect(result.plan.postFields?.terms).toEqual({
      post_tag: [
        { id: 9, name: "Walking" },
        { id: 10, name: "Lakes" },
        { name: "Mountains", new: true }
      ]
    });
    expect(
      gutenbergV2TermMismatches(result.plan.postFields!.terms!, {
        category: [],
        post_tag: [
          { id: 9, name: "Walking" },
          { id: 10, name: "Lakes" },
          { id: 55, name: "Mountains" }
        ]
      })
    ).toEqual([]);
  });

  it("asks the model again about a term that doesn't exist, then fails if it insists", async () => {
    const draft = { postFields: { terms: { post_tag: { add: ["Mountains"] } } }, operations: [] };
    const complete = client(draft, draft);

    await expect(plan(complete)).rejects.toBeInstanceOf(GutenbergV2PlanGenerationError);
    expect(complete).toHaveBeenCalledTimes(2);
    const [repair] = complete.mock.calls[1] as unknown as [Array<{ content: string }>];
    expect(repair[1]!.content).toContain(`"Mountains" isn't an existing tag`);
  });

  it("drops a change that leaves the terms as they are, and keeps a category", async () => {
    const unchanged = client(
      { postFields: { title: "Lake walks in spring", terms: { post_tag: { add: ["Walking"] } } }, operations: [] }
    );
    const result = await plan(unchanged);
    if (result.plan.operation !== "apply_operations") throw new Error("Expected an update.");
    expect(result.plan.postFields).toEqual({ title: "Lake walks in spring" });

    const noCategory = client(
      { postFields: { terms: { category: { remove: ["News & views"] } } }, operations: [] },
      { postFields: { terms: { category: { remove: ["News & views"] } } }, operations: [] }
    );
    await expect(plan(noCategory)).rejects.toThrow(/at least one category/);
  });

  it("doesn't offer terms when the editor can't set them", async () => {
    const complete = client({ postFields: { title: "New title" }, operations: [] });
    await plan(complete, false);
    const [messages] = complete.mock.calls[0] as unknown as [Array<{ content: string }>];
    expect(messages[0]!.content).not.toContain("TermChanges");
    expect(messages[0]!.content).toContain("never set postFields.terms");
    expect(JSON.parse(messages[1]!.content).availableTerms).toBeUndefined();
  });
});

describe("asking instead of guessing", () => {
  it("lets the model ask the person a question rather than plan", async () => {
    const complete = client({ clarify: "Which image do you mean?  This post has none." });
    await expect(plan(complete)).rejects.toEqual(new GutenbergV2PlanClarification("Which image do you mean? This post has none."));
    const [messages] = complete.mock.calls[0] as unknown as [Array<{ content: string }>];
    expect(messages[0]!.content).toContain('{"clarify":');
    expect(messages[0]!.content).toContain("check source.blockIndex");
    // A question is not a failed draft: no repair round.
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
