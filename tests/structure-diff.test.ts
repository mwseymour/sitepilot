import { describe, expect, it } from "vitest";

import { lineDiff, structureDiffText } from "../apps/server/src/structure-diff.js";

/** The structure link in chat apps reads as a text diff of the block markup. */
describe("review structure as text", () => {
  it("marks removed and added lines, with a little context", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"])).toEqual(["  a", "- b", "+ x", "  c"]);
  });

  it("describes the change and diffs the post's block markup", () => {
    const text = structureDiffText(
      JSON.stringify({
        operation: "apply_operations",
        before: {
          postId: 102,
          fields: { title: "Wibble" },
          rawContent: "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->"
        },
        after: {
          plan: { postFields: {} },
          serializedContent:
            "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph --><!-- wp:table --><figure><table></table></figure><!-- /wp:table -->"
        }
      })
    );
    expect(text).toContain("Changes to post 102 (apply_operations).");
    expect(text).toContain("+ <!-- wp:table --><figure><table></table></figure>");
    expect(text).toContain("  <!-- wp:paragraph --><p>Hello</p>");
    expect(text).not.toMatch(/^- /m);
    expect(structureDiffText("not json")).toBe("This review's structure couldn't be read.");
    // A tags-only change says so, and lists the tags.
    const tagsOnly = structureDiffText(
      JSON.stringify({
        operation: "apply_operations",
        before: { postId: 102, fields: { title: "Wibble" }, rawContent: "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->" },
        after: {
          plan: { postFields: { terms: { post_tag: [{ id: 9, name: "Walking" }, { name: "test123", new: true }] } } },
          serializedContent: "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->"
        }
      })
    );
    expect(tagsOnly).toContain("Tags: Walking, test123 (new)");
    expect(tagsOnly).toContain("(No change to the content.)");
  });
});
