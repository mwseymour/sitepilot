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
  });
});
