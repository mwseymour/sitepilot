import { describe, expect, it } from "vitest";

import type { PlannerContext } from "@sitepilot/contracts";
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
  });
});
