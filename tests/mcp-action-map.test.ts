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

  it("maps sitepilot-upload-media-asset tool ids", () => {
    const call = actionToMcpToolCall(
      "sitepilot-upload-media-asset",
      { fileName: "test.jpeg", mediaType: "image/jpeg" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-upload-media-asset",
      arguments: {
        file_name: "test.jpeg",
        media_type: "image/jpeg",
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

  it("passes replace_content through to update_post_fields", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        replace_content: true,
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
        replace_content: true,
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

  it("passes insert_after_paragraph through to update_post_fields", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        insert_after_paragraph: 2,
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
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
        insert_after_paragraph: 2,
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
          }
        ]
      }
    });
  });

  it("recovers the intended non-paragraph block from a malformed escaped insertion payload", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        insert_after_paragraph: 2,
        blocks: [
          {
            blockName: "core/paragraph",
            attrs: {},
            innerBlocks: [],
            innerHTML:
              "<p>Lorem ipsum dolor sit amet.&lt;!-- /wp:paragraph --&gt;\n&lt;!-- wp:paragraph --&gt;Sed do eiusmod tempor incididunt ut labore.&lt;!-- /wp:paragraph --&gt;\n&lt;!-- wp:heading --&gt;New heading!&lt;!-- /wp:heading --&gt;\n&lt;!-- wp:paragraph --&gt;Ut enim ad minim veniam.&lt;!-- /wp:paragraph --&gt;</p>",
            innerContent: [
              "<p>Lorem ipsum dolor sit amet.&lt;!-- /wp:paragraph --&gt;\n&lt;!-- wp:paragraph --&gt;Sed do eiusmod tempor incididunt ut labore.&lt;!-- /wp:paragraph --&gt;\n&lt;!-- wp:heading --&gt;New heading!&lt;!-- /wp:heading --&gt;\n&lt;!-- wp:paragraph --&gt;Ut enim ad minim veniam.&lt;!-- /wp:paragraph --&gt;</p>"
            ]
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
        insert_after_paragraph: 2,
        blocks: [
          {
            blockName: "core/heading",
            attrs: {},
            innerBlocks: [],
            innerHTML: "<h2>New heading!</h2>",
            innerContent: ["<h2>New heading!</h2>"]
          }
        ]
      }
    });
  });

  it("passes insert_position through to update_post_fields", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        insert_position: "end",
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
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
        insert_position: "end",
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
          }
        ]
      }
    });
  });

  it("passes insert_after_block through to update_post_fields", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        insert_after_block: {
          block_name: "core/heading",
          from_end: true
        },
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
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
        insert_after_block: {
          block_name: "core/heading",
          from_end: true
        },
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
          }
        ]
      }
    });
  });

  it("passes insert_before_block through to update_post_fields", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      {
        post_id: 12,
        insert_before_block: {
          block_name: "core/heading",
          from_end: true
        },
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
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
        insert_before_block: {
          block_name: "core/heading",
          from_end: true
        },
        blocks: [
          {
            blockName: "core/image",
            attrs: {
              id: 0,
              url: "https://example.test/wp-content/uploads/test.jpeg",
              alt: "test"
            },
            innerBlocks: [],
            innerHTML:
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
            innerContent: [
              '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>'
            ]
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

  it("maps meta_desc alias for set_post_seo_meta", () => {
    const call = actionToMcpToolCall(
      "set_post_seo_meta",
      { postId: 3, meta_desc: "wibble" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-set-post-seo-meta",
      arguments: {
        post_id: 3,
        dry_run: false,
        seo_description: "wibble"
      }
    });
  });

  it("reroutes update_post_fields meta_desc-only input to SEO meta", () => {
    const call = actionToMcpToolCall(
      "update_post_fields",
      { post_id: 46, meta_desc: "wibble" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-set-post-seo-meta",
      arguments: {
        post_id: 46,
        dry_run: false,
        seo_description: "wibble"
      }
    });
  });

  it("maps set_post_featured_image", () => {
    const call = actionToMcpToolCall(
      "set_post_featured_image",
      { post_id: 46, attachment_id: 201 },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-set-post-featured-image",
      arguments: {
        post_id: 46,
        attachment_id: 201,
        dry_run: false
      }
    });
  });

  it("reroutes seo-meta featured_image-only input to featured image tool", () => {
    const call = actionToMcpToolCall(
      "sitepilot-set-post-seo-meta",
      { post_id: 46, featured_image: "https://example.test/test.jpeg" },
      false
    );
    expect(call).toEqual({
      toolName: "sitepilot-set-post-featured-image",
      arguments: {
        post_id: 46,
        featured_image_url: "https://example.test/test.jpeg",
        dry_run: false
      }
    });
  });
});
