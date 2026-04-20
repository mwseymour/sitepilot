import { describe, expect, it } from "vitest";

import {
  buildPostLookupArguments,
  canResolveActionViaPostLookup,
  resolvePostIdFromLookupResult
} from "@sitepilot/services";

describe("post target resolution", () => {
  it("builds lookup arguments from explicit lookup fields", () => {
    expect(
      buildPostLookupArguments({
        lookup_status: "draft",
        lookup_post_type: "page",
        lookup_slug: "pricing"
      })
    ).toEqual({
      post_type: "page",
      status: "draft",
      slug: "pricing",
      limit: 2
    });
  });

  it("treats update actions with lookup metadata as resolvable", () => {
    expect(
      canResolveActionViaPostLookup("update_post_fields", {
        lookup_status: "draft"
      })
    ).toBe(true);
  });

  it("treats update_post aliases with lookup metadata as resolvable", () => {
    expect(
      canResolveActionViaPostLookup("update_post", {
        lookup_status: "draft"
      })
    ).toBe(true);
  });

  it("returns a resolved post id when lookup finds a unique match", () => {
    expect(
      resolvePostIdFromLookupResult({
        ok: true,
        total_matches: 1,
        truncated: false,
        matches: [{ post_id: 42, post_title: "Draft" }]
      })
    ).toEqual({ ok: true, postId: 42 });
  });

  it("treats multiple matches as ambiguous", () => {
    expect(
      resolvePostIdFromLookupResult({
        ok: true,
        total_matches: 2,
        truncated: false,
        matches: [
          { post_id: 42, post_title: "Draft A" },
          { post_id: 43, post_title: "Draft B" }
        ]
      })
    ).toEqual({
      ok: false,
      code: "post_lookup_ambiguous",
      message:
        "The requested target matched more than one post. Add a slug or a more specific filter."
    });
  });
});
