import { describe, expect, it } from "vitest";

import { actionToMcpToolCall } from "../packages/services/src/mcp-action-map.ts";

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

  it("passes structured blocks through to create_draft_post", () => {
    const call = actionToMcpToolCall(
      "create_draft_post",
      {
        title: "Hello",
        blocks: [
          {
            blockName: "core/paragraph",
            attrs: {},
            innerBlocks: [],
            innerHTML: "<p>Body</p>",
            innerContent: ["<p>Body</p>"]
          }
        ]
      },
      true
    );
    expect(call).toEqual({
      toolName: "sitepilot-create-draft-post",
      arguments: {
        post_type: "post",
        title: "Hello",
        blocks: [
          {
            blockName: "core/paragraph",
            attrs: {},
            innerBlocks: [],
            innerHTML: "<p>Body</p>",
            innerContent: ["<p>Body</p>"]
          }
        ],
        dry_run: true
      }
    });
  });

  it("passes blocks and legacy content through when both are present", () => {
    const blocks = [
      {
        blockName: "core/paragraph",
        attrs: {},
        innerBlocks: [],
        innerHTML: "<p>Structured body</p>",
        innerContent: ["<p>Structured body</p>"]
      }
    ];
    const call = actionToMcpToolCall(
      "create_draft_post",
      {
        title: "Hello",
        content: "<!-- wp:paragraph --><p>Legacy body</p><!-- /wp:paragraph -->",
        blocks
      },
      true
    );

    expect(call).toEqual({
      toolName: "sitepilot-create-draft-post",
      arguments: {
        post_type: "post",
        title: "Hello",
        content:
          "<!-- wp:paragraph --><p>Legacy body</p><!-- /wp:paragraph -->",
        blocks,
        dry_run: true
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

  it("passes structured blocks through to update_post_fields", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        blocks: [
          {
            blockName: "core/paragraph",
            attrs: {},
            innerBlocks: [],
            innerHTML: "<p>Fresh body</p>",
            innerContent: ["<p>Fresh body</p>"]
          }
        ]
      },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-update-post-fields",
      arguments: {
        post_id: 12,
        dry_run: false,
        blocks: [
          {
            blockName: "core/paragraph",
            attrs: {},
            innerBlocks: [],
            innerHTML: "<p>Fresh body</p>",
            innerContent: ["<p>Fresh body</p>"]
          }
        ]
      }
    });
  });

  it("passes nested layout blocks through unchanged to update_post_fields", () => {
    const blocks = [
      {
        blockName: "core/columns",
        attrs: {},
        innerBlocks: [
          {
            blockName: "core/column",
            attrs: { width: "50%" },
            innerBlocks: [
              {
                blockName: "core/paragraph",
                attrs: {},
                innerBlocks: [],
                innerHTML: "<p>Text left</p>",
                innerContent: ["<p>Text left</p>"]
              }
            ],
            innerHTML: "",
            innerContent: [null]
          },
          {
            blockName: "core/column",
            attrs: { width: "50%" },
            innerBlocks: [
              {
                blockName: "core/image",
                attrs: {
                  id: 0,
                  url: "https://upload.wikimedia.org/example.jpg",
                  alt: "Example image"
                },
                innerBlocks: [],
                innerHTML:
                  '<figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Example image" /></figure>',
                innerContent: [
                  '<figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Example image" /></figure>'
                ]
              }
            ],
            innerHTML: "",
            innerContent: [null]
          }
        ],
        innerHTML: "",
        innerContent: [null]
      },
      {
        blockName: "core/spacer",
        attrs: { height: "40px" },
        innerBlocks: [],
        innerHTML:
          '<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>',
        innerContent: [
          '<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>'
        ]
      }
    ];

    const call = actionToMcpToolCall(
      "update_post_fields",
      { post_id: 12, blocks },
      false
    );

    expect(call?.arguments.blocks).toBe(blocks);
  });

  it("maps nested planner input blocks for create_draft_post", () => {
    const blocks = [
      {
        blockName: "core/paragraph",
        attrs: {},
        innerBlocks: [],
        innerHTML: "<p>Nested body</p>",
        innerContent: ["<p>Nested body</p>"]
      }
    ];

    const call = actionToMcpToolCall(
      "create_draft_post",
      {
        post_title: "Nested",
        input: { blocks }
      },
      false
    );

    expect(call).toEqual({
      toolName: "sitepilot-create-draft-post",
      arguments: {
        post_type: "post",
        title: "Nested",
        blocks,
        dry_run: false
      }
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
