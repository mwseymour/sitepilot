import { describe, expect, it } from "vitest";

import {
  SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES,
  type PlannerContext
} from "@sitepilot/contracts";
import type {
  ChatModelClient,
  ChatMessage
} from "@sitepilot/provider-adapters";
import { buildLlmActionPlan } from "../packages/services/src/generate-action-plan.ts";

function makePlannerContext(text: string): PlannerContext {
  return {
    siteId: "site-1",
    threadId: "thread-1",
    builtAt: "2026-04-20T12:00:00.000Z",
    siteConfig: null,
    discoverySummary: null,
    messages: [
      {
        messageId: "msg-1",
        role: "user",
        format: "plain_text",
        text,
        createdAt: "2026-04-20T12:00:00.000Z",
        requestId: "req-1"
      }
    ],
    targetSummaries: [],
    priorChanges: []
  };
}

function makeClient(
  resultText: string,
  onComplete?: (messages: ChatMessage[]) => void
): ChatModelClient {
  return {
    providerId: "openai",
    async complete(messages) {
      onComplete?.(messages);
      return {
        text: resultText,
        usage: {
          inputTokens: 100,
          outputTokens: 200
        }
      };
    }
  };
}

function collectBlockNames(blocks: unknown[]): string[] {
  const names = new Set<string>();

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.blockName === "string") {
      names.add(record.blockName);
    }
    if (Array.isArray(record.innerBlocks)) {
      for (const innerBlock of record.innerBlocks) {
        visit(innerBlock);
      }
    }
  };

  for (const block of blocks) {
    visit(block);
  }

  return [...names];
}

describe("buildLlmActionPlan", () => {
  it("normalizes plain text post content into paragraph blocks", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Write a short launch update",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Launch Update",
              content: "First paragraph.\n\nSecond paragraph.",
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Write a short launch update."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const content = result.plan.proposedActions[0]!.input.content;
    expect(content).toContain("<!-- wp:paragraph -->");
    expect(content).toContain("<p>First paragraph.</p>");
    expect(content).toContain("<p>Second paragraph.</p>");
    expect(result.plan.validationWarnings).toContain(
      "Planner returned post content without Gutenberg block serialization; normalized it into paragraph blocks."
    );
  });

  it("falls back to paragraph blocks when simple content has malformed serialization", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Draft a short announcement",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Announcement",
              content:
                "<!-- wp:paragraph --><p>Hello world.</p><!-- /wp:heading -->",
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext(
        "Draft a short announcement about the launch."
      ),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const content = result.plan.proposedActions[0]!.input.content;
    expect(content).toBe(
      "<!-- wp:paragraph --><p>Hello world.</p><!-- /wp:paragraph -->"
    );
    expect(result.plan.validationWarnings[0]).toContain(
      "Planner returned malformed Gutenberg block serialization"
    );
  });

  it("warns when the planner adds advanced blocks the operator did not request", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Write a short team bio",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Team Bio",
              content:
                '<!-- wp:image {"id":0,"url":"https://upload.wikimedia.org/example.jpg"} --><figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Headshot" /></figure><!-- /wp:image -->\n<!-- wp:paragraph --><p>Short bio copy.</p><!-- /wp:paragraph -->',
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Write a short team bio for the About page."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    expect(result.plan.validationWarnings).toContain(
      "Planner added advanced blocks not clearly requested by the operator: core/image."
    );
  });

  it("normalizes high-risk media-text blocks to paragraphs to avoid recovery", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Write staff bios with photos",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Staff Bios",
              content:
                '<!-- wp:media-text {"mediaPosition":"left"} --><div class="wp-block-media-text"><figure class="wp-block-media-text__media"><img src="https://upload.wikimedia.org/example.jpg" alt="Headshot" /></figure><div class="wp-block-media-text__content"><p>Short bio copy.</p></div></div><!-- /wp:media-text -->',
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Write staff bios with photos."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    expect(result.plan.proposedActions[0]!.input.content).toContain(
      "<!-- wp:paragraph -->"
    );
    expect(result.plan.validationWarnings).toContain(
      "Planner used high-risk Gutenberg block types (core/media-text); normalized content to paragraph blocks to avoid editor recovery."
    );
  });

  it("warns when structured parsed blocks include unsupported block types", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a gallery layout",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Cover Page",
              post_type: "page",
              blocks: [
                {
                  blockName: "core/gallery",
                  attrs: {
                    url: "https://upload.wikimedia.org/example.jpg"
                  },
                  innerBlocks: [],
                  innerHTML: "<div class=\"wp-block-cover\"></div>",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext(
        "Create a page with a gallery block."
      ),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    expect(result.plan.validationWarnings).toContain(
      'Structured parsed blocks include unsupported block types that execution will reject: core/gallery. Supported blocks today: core/button, core/buttons, core/code, core/column, core/columns, core/details, core/file, core/group, core/heading, core/html, core/image, core/list, core/list-item, core/media-text, core/more, core/paragraph, core/preformatted, core/pullquote, core/quote, core/separator, core/shortcode, core/spacer, core/table, core/video, core/verse. Add blocked blocks manually in the WordPress post editor for now.'
    );
  });

  it("canonicalizes standalone block batch 1 shapes", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a draft with standalone blocks",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Standalone Blocks",
              post_type: "page",
              blocks: [
                {
                  blockName: "core/quote",
                  attrs: {},
                  innerBlocks: [],
                  innerHTML: "Quoted line",
                  innerContent: ["Quoted line"]
                },
                {
                  blockName: "core/code",
                  attrs: {},
                  innerBlocks: [],
                  innerHTML: "const x = 1;",
                  innerContent: ["const x = 1;"]
                },
                {
                  blockName: "core/separator",
                  attrs: {},
                  innerBlocks: [],
                  innerHTML: "",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Create a draft with quote, code, and separator blocks."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const blocks = result.plan.proposedActions[0]!.input.blocks as Array<{
      blockName: string;
      innerHTML: string;
    }>;
    expect(blocks[0]?.innerHTML).toBe(
      '<blockquote class="wp-block-quote"><p>Quoted line</p></blockquote>'
    );
    expect(blocks[1]?.innerHTML).toBe(
      '<pre class="wp-block-code"><code>const x = 1;</code></pre>'
    );
    expect(blocks[2]?.innerHTML).toBe(
      '<hr class="wp-block-separator has-alpha-channel-opacity"/>'
    );
  });

  it("canonicalizes list containers and list items", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a draft with a list",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "List Blocks",
              post_type: "page",
              blocks: [
                {
                  blockName: "core/list",
                  attrs: {
                    ordered: true,
                    start: 3
                  },
                  innerBlocks: [
                    {
                      blockName: "core/list-item",
                      attrs: {},
                      innerBlocks: [],
                      innerHTML: "First item",
                      innerContent: ["First item"]
                    },
                    {
                      blockName: "core/list-item",
                      attrs: {},
                      innerBlocks: [],
                      innerHTML: "<li class=\"custom\">Second item</li>",
                      innerContent: ["<li class=\"custom\">Second item</li>"]
                    }
                  ],
                  innerHTML: "",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Create an ordered list with two items."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const blocks = result.plan.proposedActions[0]!.input.blocks as Array<{
      blockName: string;
      innerHTML: string;
      innerContent: Array<string | null>;
      innerBlocks?: Array<{ innerHTML: string }>;
    }>;
    expect(blocks[0]?.blockName).toBe("core/list");
    expect(blocks[0]?.innerContent).toEqual([
      '<ol class="wp-block-list" start="3">',
      null,
      null,
      "</ol>"
    ]);
    expect(blocks[0]?.innerBlocks?.[0]?.innerHTML).toBe("<li>First item</li>");
    expect(blocks[0]?.innerBlocks?.[1]?.innerHTML).toBe("<li>Second item</li>");
  });

  it("canonicalizes buttons, group, and details containers", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a draft with buttons, group, and details",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Container Blocks",
              post_type: "page",
              blocks: [
                {
                  blockName: "core/buttons",
                  attrs: {},
                  innerBlocks: [
                    {
                      blockName: "core/button",
                      attrs: {
                        url: "https://example.com",
                        text: "Read More"
                      },
                      innerBlocks: [],
                      innerHTML: "",
                      innerContent: []
                    }
                  ],
                  innerHTML: "",
                  innerContent: []
                },
                {
                  blockName: "core/group",
                  attrs: {
                    tagName: "section"
                  },
                  innerBlocks: [
                    {
                      blockName: "core/paragraph",
                      attrs: {},
                      innerBlocks: [],
                      innerHTML: "Inside group",
                      innerContent: ["Inside group"]
                    }
                  ],
                  innerHTML: "",
                  innerContent: []
                },
                {
                  blockName: "core/details",
                  attrs: {
                    summary: "FAQ",
                    showContent: true
                  },
                  innerBlocks: [
                    {
                      blockName: "core/paragraph",
                      attrs: {},
                      innerBlocks: [],
                      innerHTML: "Answer",
                      innerContent: ["Answer"]
                    }
                  ],
                  innerHTML: "",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext(
        "Create a page using buttons, a group wrapper, and a details disclosure."
      ),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const blocks = result.plan.proposedActions[0]!.input.blocks as Array<{
      blockName: string;
      innerHTML: string;
      innerContent: Array<string | null>;
      innerBlocks?: Array<{ innerHTML: string; innerContent: Array<string | null> }>;
    }>;

    expect(blocks[0]?.innerContent).toEqual([
      '<div class="wp-block-buttons">',
      null,
      "</div>"
    ]);
    expect(blocks[0]?.innerBlocks?.[0]?.innerHTML).toBe(
      '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://example.com">Read More</a></div>'
    );
    expect(blocks[1]?.innerContent).toEqual([
      '<section class="wp-block-group">',
      null,
      "</section>"
    ]);
    expect(blocks[2]?.innerContent).toEqual([
      '<details class="wp-block-details" open><summary>FAQ</summary>',
      null,
      "</details>"
    ]);
  });

  it("canonicalizes pullquote, table, and media-text blocks", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a draft with advanced blocks",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Advanced Blocks",
              post_type: "page",
              blocks: [
                {
                  blockName: "core/pullquote",
                  attrs: {
                    value: "Big quote",
                    citation: "Author"
                  },
                  innerBlocks: [],
                  innerHTML: "Big quote",
                  innerContent: ["Big quote"]
                },
                {
                  blockName: "core/table",
                  attrs: {
                    caption: "Pricing",
                    body: [
                      {
                        cells: [
                          { tag: "th", content: "Plan", scope: "col" },
                          { tag: "th", content: "Price", scope: "col" }
                        ]
                      },
                      {
                        cells: [
                          { tag: "td", content: "Starter" },
                          { tag: "td", content: "$10" }
                        ]
                      }
                    ]
                  },
                  innerBlocks: [],
                  innerHTML: "",
                  innerContent: []
                },
                {
                  blockName: "core/media-text",
                  attrs: {
                    mediaType: "image",
                    mediaUrl: "https://example.com/photo.jpg",
                    mediaAlt: "Photo",
                    mediaPosition: "right",
                    mediaWidth: 40,
                    isStackedOnMobile: true
                  },
                  innerBlocks: [
                    {
                      blockName: "core/paragraph",
                      attrs: {},
                      innerBlocks: [],
                      innerHTML: "Media text body",
                      innerContent: ["Media text body"]
                    }
                  ],
                  innerHTML: "",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Create pullquote, table, and media text blocks."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const blocks = result.plan.proposedActions[0]!.input.blocks as Array<{
      innerHTML: string;
      innerContent: Array<string | null>;
    }>;
    expect(blocks[0]?.innerHTML).toBe(
      '<figure class="wp-block-pullquote"><blockquote><p>Big quote</p><cite>Author</cite></blockquote></figure>'
    );
    expect(blocks[1]?.innerHTML).toContain('<figure class="wp-block-table"><table class="has-fixed-layout">');
    expect(blocks[1]?.innerHTML).toContain("<figcaption class=\"wp-element-caption\">Pricing</figcaption>");
    expect(blocks[2]?.innerContent).toEqual([
      '<div class="wp-block-media-text has-media-on-the-right is-stacked-on-mobile" style="grid-template-columns:auto 40%">',
      '<div class="wp-block-media-text__content">',
      null,
      "</div>",
      '<figure class="wp-block-media-text__media"><img src="https://example.com/photo.jpg" alt="Photo"/></figure>',
      "</div>"
    ]);
  });

  it("canonicalizes more, html, shortcode, file, read-more, video, and cover blocks", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a draft with raw and media blocks",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Requested Blocks",
              post_type: "page",
              blocks: [
                { blockName: "core/more", attrs: { customText: "Continue", noTeaser: true }, innerBlocks: [], innerHTML: "", innerContent: [] },
                { blockName: "core/html", attrs: { content: "<div>Raw HTML</div>" }, innerBlocks: [], innerHTML: "", innerContent: [] },
                { blockName: "core/shortcode", attrs: { text: "[gallery ids=\"1,2\"]" }, innerBlocks: [], innerHTML: "", innerContent: [] },
                { blockName: "core/file", attrs: { href: "https://example.com/file.pdf", fileName: "Brochure.pdf", fileId: "file-link", downloadButtonText: "Download file" }, innerBlocks: [], innerHTML: "", innerContent: [] },
                { blockName: "core/read-more", attrs: { content: "Read more", linkTarget: "_self" }, innerBlocks: [], innerHTML: "", innerContent: [] },
                { blockName: "core/video", attrs: { src: "https://example.com/video.mp4", controls: true, caption: "Demo video" }, innerBlocks: [], innerHTML: "", innerContent: [] },
                {
                  blockName: "core/cover",
                  attrs: { url: "https://example.com/hero.jpg", alt: "Hero", dimRatio: 60 },
                  innerBlocks: [
                    { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "Overlay text", innerContent: ["Overlay text"] }
                  ],
                  innerHTML: "",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Create a page using more, html, shortcode, file, read-more, video, and cover blocks."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const blocks = result.plan.proposedActions[0]!.input.blocks as Array<{
      innerHTML: string;
      innerContent: Array<string | null>;
    }>;
    expect(blocks[0]?.innerHTML).toBe("<!--more Continue-->\n<!--noteaser-->");
    expect(blocks[1]?.innerHTML).toBe("<div>Raw HTML</div>");
    expect(blocks[2]?.innerHTML).toBe("[gallery ids=\"1,2\"]");
    expect(blocks[3]?.innerHTML).toContain('class="wp-block-file"');
    expect(blocks[4]?.innerHTML).toBe("");
    expect(blocks[4]?.innerContent).toEqual([]);
    expect(blocks[5]?.innerHTML).toContain('<figure class="wp-block-video"><video controls src="https://example.com/video.mp4">');
    expect(blocks[6]?.innerContent).toEqual([
      '<div class="wp-block-cover">',
      '<img class="wp-block-cover__image-background" alt="Hero" src="https://example.com/hero.jpg" style="object-position:50% 50%" data-object-fit="cover" data-object-position="50% 50%"/>',
      '<span aria-hidden="true" class="wp-block-cover__background has-background-dim-60 has-background-dim"></span>',
      '<div class="wp-block-cover__inner-container">',
      null,
      "</div>",
      "</div>"
    ]);
  });

  it("preserves requested columns content instead of flattening it", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a test post with alternating columns",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "test 5",
              content:
                '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column {"width":"50%"} --><div class="wp-block-column" style="flex-basis:50%"><!-- wp:paragraph --><p>Dummy text for the first column.</p><!-- /wp:paragraph --></div><!-- /wp:column --><!-- wp:column {"width":"50%"} --><div class="wp-block-column" style="flex-basis:50%"><!-- wp:image {"id":0,"url":"https://upload.wikimedia.org/example.jpg","alt":"Random image"} --><figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Random image" /></figure><!-- /wp:image --></div><!-- /wp:column --></div><!-- /wp:columns -->\n<!-- wp:spacer {"height":"40px"} --><div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div><!-- /wp:spacer -->',
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext(
        "Create a new post called test 5 and add some dummy text in the post content - wp blocks. Use columns block with 2 column block inside it 50/50 split with text left (first column) and a random image in column 2. Then duplicate but have image on left. Spacer block between the 2 columns blocks."
      ),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const content = String(result.plan.proposedActions[0]!.input.content);
    expect(content).toContain("<!-- wp:columns -->");
    expect(content).toContain("<!-- wp:spacer");
    expect(result.plan.validationWarnings).not.toContain(
      "Planner returned post content without Gutenberg block serialization; normalized it into paragraph blocks."
    );
  });

  it("preserves structured blocks without normalizing fallback content", async () => {
    const blocks = [
      {
        blockName: "core/paragraph",
        attrs: {},
        innerBlocks: [],
        innerHTML: "<p>Structured body.</p>",
        innerContent: ["<p>Structured body.</p>"]
      }
    ];
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a post from structured blocks",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Structured",
              content: "Fallback plain content",
              blocks,
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Create a post from structured blocks."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    expect(result.plan.proposedActions[0]!.input.blocks).toEqual(blocks);
    expect(result.plan.proposedActions[0]!.input.content).toBe(
      "Fallback plain content"
    );
    expect(result.plan.validationWarnings).not.toContain(
      "Planner returned post content without Gutenberg block serialization; normalized it into paragraph blocks."
    );
  });

  it("normalizes nested planner block arguments into parsed blocks", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Create a post with columns",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              post_title: "Columns",
              input: {
                blocks: [
                  {
                    blockName: "wp:columns",
                    attrs: {},
                    innerBlocks: [
                      {
                        blockName: "wp:column",
                        attrs: {},
                        innerBlocks: [
                          {
                            blockName: "wp:paragraph",
                            attrs: {},
                            innerHTML: "Left copy",
                            innerContent: ["Left copy"]
                          }
                        ],
                        innerContent: []
                      },
                      {
                        blockName: "wp:column",
                        attrs: {},
                        innerBlocks: [
                          {
                            blockName: "wp:image",
                            attrs: {
                              id: 24,
                              url: "https://test.localhost:8890/wp-content/uploads/2026/04/test.jpeg",
                              alt: "",
                              sizeSlug: "full",
                              linkDestination: "none"
                            },
                            innerHTML:
                              '<figure class="wp-block-image"><img src="https://test.localhost:8890/wp-content/uploads/2026/04/test.jpeg" alt="" /></figure>',
                            innerContent: []
                          }
                        ],
                        innerContent: ["unexpected wrapper copy"]
                      }
                    ],
                    innerContent: ["unexpected columns copy"]
                  },
                  {
                    blockName: "wp:spacer",
                    attrs: { height: 20 },
                    innerBlocks: [],
                    innerHTML: "",
                    innerContent: []
                  }
                ]
              }
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext("Create a post with columns."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    const nestedInput = result.plan.proposedActions[0]!.input.input as {
      blocks: Array<{
        blockName: string;
        attrs: Record<string, unknown>;
        innerHTML: string;
        innerContent: unknown[];
        innerBlocks: Array<{
          innerContent: unknown[];
          innerBlocks: Array<{
            innerHTML: string;
            innerContent: unknown[];
            attrs: Record<string, unknown>;
          }>;
        }>;
      }>;
    };
    const columns = nestedInput.blocks[0]!;
    const spacer = nestedInput.blocks[1]!;
    const paragraph = columns.innerBlocks[0]!.innerBlocks[0]!;
    const image = columns.innerBlocks[1]!.innerBlocks[0]!;

    expect(columns.blockName).toBe("core/columns");
    expect(columns.innerContent).toEqual([
      '<div class="wp-block-columns">',
      null,
      "\n\n",
      null,
      "</div>"
    ]);
    expect(columns.innerBlocks[0]!.innerContent).toEqual([
      '<div class="wp-block-column">',
      null,
      "</div>"
    ]);
    expect(columns.innerBlocks[1]!.innerContent).toEqual([
      '<div class="wp-block-column">',
      null,
      "</div>"
    ]);
    expect(paragraph.innerHTML).toBe("<p>Left copy</p>");
    expect(paragraph.innerContent).toEqual(["<p>Left copy</p>"]);
    expect(image.innerHTML).toBe(
      '<figure class="wp-block-image size-full"><img src="https://test.localhost:8890/wp-content/uploads/2026/04/test.jpeg" alt="" class="wp-image-24"/></figure>'
    );
    expect(image.innerContent).toEqual([image.innerHTML]);
    expect(spacer.innerContent).toEqual([
      '<div style="height:20px" aria-hidden="true" class="wp-block-spacer"></div>'
    ]);
    expect(spacer.attrs).toEqual({ height: "20px" });
    expect(result.plan.validationWarnings).toContain(
      'Normalized blockName at blocks[0] from "wp:columns" to "core/columns".'
    );
  });

  it("instructs the model not to invent blocks or layouts", async () => {
    let systemPrompt = "";
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Write a short post",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Post",
              content:
                "<!-- wp:paragraph --><p>Hello.</p><!-- /wp:paragraph -->",
              post_type: "post"
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: []
      }),
      (messages) => {
        systemPrompt = messages[0]?.content ?? "";
      }
    );

    await buildLlmActionPlan({
      context: makePlannerContext("Write a short post."),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    expect(systemPrompt).toContain(
      "Do not invent deliverables, sections, media, layouts, or block types the operator did not ask for."
    );
    expect(systemPrompt).toContain(
      "Every opening block delimiter must have the correct matching closing delimiter"
    );
    expect(systemPrompt).toContain(
      "Use input.blocks as an array of WordPress parsed block objects"
    );
    expect(systemPrompt).toContain(
      'never use comment prefixes such as "wp:columns" in parsed blockName'
    );
  });

  it("instructs the model to include every supported block for explicit all-block requests", async () => {
    let systemPrompt = "";
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Add every executable block",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "update_post_fields",
            version: 1,
            input: {
              post_id: 50,
              blocks: []
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: false,
            rollbackSupported: true
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      }),
      (messages) => {
        systemPrompt = messages[0]?.content ?? "";
      }
    );

    await buildLlmActionPlan({
      context: makePlannerContext(
        "Add one of every executable block you can to post 50."
      ),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      client,
      model: "gpt-test"
    });

    expect(systemPrompt).toContain(
      "The operator explicitly asked for one of every executable/supported block."
    );
    expect(systemPrompt).toContain(
      "counting nested child blocks such as core/button inside core/buttons"
    );
  });

  it("replaces partial parsed blocks with a complete supported block demo for explicit all-block requests", async () => {
    const client = makeClient(
      JSON.stringify({
        requestSummary: "Add every executable block",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "update_post_fields",
            version: 1,
            input: {
              post_id: 50,
              blocks: [
                {
                  blockName: "core/heading",
                  attrs: {},
                  innerBlocks: [],
                  innerHTML: "<h2>Sample Heading</h2>",
                  innerContent: ["<h2>Sample Heading</h2>"]
                },
                {
                  blockName: "core/paragraph",
                  attrs: {},
                  innerBlocks: [],
                  innerHTML: "<p>Sample paragraph.</p>",
                  innerContent: ["<p>Sample paragraph.</p>"]
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "medium",
            dryRunCapable: false,
            rollbackSupported: true
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "medium",
        rollbackNotes: [],
        validationWarnings: []
      })
    );

    const result = await buildLlmActionPlan({
      context: makePlannerContext(
        "Add one of every executable block you can to post 50."
      ),
      requestId: "req-1",
      siteId: "site-1",
      nowIso: "2026-04-20T12:00:00.000Z",
      requestAttachments: [
        {
          fileName: "Totally-Communications-team.jpg",
          mediaType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,ZmFrZQ=="
        }
      ],
      client,
      model: "gpt-test"
    });

    const blocks = result.plan.proposedActions[0]!.input.blocks as unknown[];
    const blockNames = collectBlockNames(blocks);

    for (const supportedBlockName of SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES) {
      expect(blockNames).toContain(supportedBlockName);
    }

    expect(
      result.plan.validationWarnings.some((warning) =>
        warning.includes(
          "replaced the partial block set with a complete executable-block demo"
        )
      )
    ).toBe(true);
    expect(JSON.stringify(blocks)).toContain(
      "Totally-Communications-team.jpg"
    );
  });
});
