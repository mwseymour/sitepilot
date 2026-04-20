import { describe, expect, it } from "vitest";

import { actionToMcpToolCall } from "@sitepilot/services";

describe("actionToMcpToolCall", () => {
  it("returns null for interpret_request", () => {
    expect(
      actionToMcpToolCall("interpret_request", { summary: "x" }, true)
    ).toBeNull();
  });

  it("maps create_draft_post with dry_run", () => {
    const call = actionToMcpToolCall(
      "create_draft_post",
      { title: "Hello", content: "Body", post_type: "post" },
      true
    );
    expect(call).toEqual({
      toolName: "sitepilot-create-draft-post",
      arguments: {
        post_type: "post",
        title: "Hello",
        content: "Body",
        dry_run: true
      }
    });
  });

  it("maps createDraftPost camelCase actions", () => {
    const call = actionToMcpToolCall(
      "createDraftPost",
      { postTitle: "Hello Matt", postContent: "Body", postType: "post" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-create-draft-post",
      arguments: {
        post_type: "post",
        title: "Hello Matt",
        content: "Body",
        dry_run: false
      }
    });
  });

  it("maps update_post_fields when post id present", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      { post_id: 12, title: "T" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-update-post-fields",
      arguments: { post_id: 12, dry_run: false, title: "T" }
    });
  });

  it("maps update_post aliases when post id present", () => {
    const call = actionToMcpToolCall(
      "update_post",
      { post_id: 12, content: "Fresh body" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-update-post-fields",
      arguments: { post_id: 12, dry_run: false, content: "Fresh body" }
    });
  });

  it("maps sitepilot-update-post-fields tool ids", () => {
    const call = actionToMcpToolCall(
      "sitepilot-update-post-fields",
      { post_id: 12, content: "Fresh body" },
      true
    );
    expect(call).toEqual({
      toolName: "sitepilot-update-post-fields",
      arguments: { post_id: 12, dry_run: true, content: "Fresh body" }
    });
  });

  it("maps set_post_seo_meta", () => {
    const call = actionToMcpToolCall(
      "set_post_seo_meta",
      { postId: 3, seo_title: "S", seo_description: "D" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-set-post-seo-meta",
      arguments: {
        post_id: 3,
        dry_run: false,
        seo_title: "S",
        seo_description: "D"
      }
    });
  });
});
