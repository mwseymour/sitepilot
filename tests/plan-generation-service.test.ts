import { beforeEach, describe, expect, it, vi } from "vitest";

const site = {
  id: "site-1",
  workspaceId: "workspace-1",
  activationStatus: "active"
};

const request = {
  id: "request-1",
  siteId: site.id,
  threadId: "thread-1",
  requestedBy: {
    userProfileId: "local-operator",
    appRole: "requester",
    siteRoles: ["request"]
  },
  status: "new",
  userPrompt:
    "Create a page called Screenshot test 4 and try match this layout.\n\nAdditional context:\nUse no image",
  latestPlanId: "plan-prev",
  createdAt: "2026-04-29T11:57:41.385Z",
  updatedAt: "2026-04-29T11:57:41.385Z"
};

const previousStructuredPlan = {
  id: "plan-prev",
  requestId: request.id,
  siteId: request.siteId,
  requestSummary: "Create the screenshot layout.",
  assumptions: [],
  openQuestions: [],
  targetEntities: ["page:Screenshot test 4"],
  proposedActions: [
    {
      id: "action-1",
      type: "create_draft_post",
      version: 1,
      input: {
        title: "Screenshot test 4",
        post_type: "page",
        post_status: "draft",
        blocks: [
          {
            blockName: "core/heading",
            attrs: { level: 1 },
            innerBlocks: [],
            innerHTML: "<h1>Our services</h1>",
            innerContent: ["<h1>Our services</h1>"]
          },
          {
            blockName: "core/columns",
            attrs: {},
            innerBlocks: [
              {
                blockName: "core/column",
                attrs: { width: "66.66%" },
                innerBlocks: [
                  {
                    blockName: "core/image",
                    attrs: {
                      id: 123,
                      url: "https://example.test/image.png",
                      alt: "Example"
                    },
                    innerBlocks: [],
                    innerHTML:
                      '<figure class="wp-block-image"><img src="https://example.test/image.png" alt="Example"/></figure>',
                    innerContent: [
                      '<figure class="wp-block-image"><img src="https://example.test/image.png" alt="Example"/></figure>'
                    ]
                  },
                  {
                    blockName: "core/heading",
                    attrs: { level: 2 },
                    innerBlocks: [],
                    innerHTML: "<h2>SEO / Organic Marketing</h2>",
                    innerContent: ["<h2>SEO / Organic Marketing</h2>"]
                  },
                  {
                    blockName: "core/buttons",
                    attrs: {},
                    innerBlocks: [
                      {
                        blockName: "core/button",
                        attrs: {},
                        innerBlocks: [],
                        innerHTML:
                          '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button">Find out more</a></div>',
                        innerContent: [
                          '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button">Find out more</a></div>'
                        ]
                      }
                    ],
                    innerHTML: '<div class="wp-block-buttons"></div>',
                    innerContent: ['<div class="wp-block-buttons">', null, "</div>"]
                  }
                ],
                innerHTML: '<div class="wp-block-column"></div>',
                innerContent: ['<div class="wp-block-column">', null, null, null, "</div>"]
              },
              {
                blockName: "core/column",
                attrs: { width: "33.34%" },
                innerBlocks: [
                  {
                    blockName: "core/group",
                    attrs: {},
                    innerBlocks: [
                      {
                        blockName: "core/paragraph",
                        attrs: {},
                        innerBlocks: [],
                        innerHTML: "<p>Related work</p>",
                        innerContent: ["<p>Related work</p>"]
                      }
                    ],
                    innerHTML: '<div class="wp-block-group"></div>',
                    innerContent: ['<div class="wp-block-group">', null, "</div>"]
                  }
                ],
                innerHTML: '<div class="wp-block-column"></div>',
                innerContent: ['<div class="wp-block-column">', null, "</div>"]
              }
            ],
            innerHTML: '<div class="wp-block-columns"></div>',
            innerContent: ['<div class="wp-block-columns">', null, null, "</div>"]
          }
        ]
      },
      targetEntityRefs: ["page:Screenshot test 4"],
      permissionRequirement: "edit_pages",
      riskLevel: "low",
      dryRunCapable: true,
      rollbackSupported: false
    }
  ],
  dependencies: [],
  approvalRequired: false,
  riskLevel: "low",
  rollbackNotes: [],
  validationWarnings: [],
  createdAt: "2026-04-29T11:57:41.385Z",
  updatedAt: "2026-04-29T11:57:41.385Z"
};

const flattenedPlan = {
  id: "plan-new",
  requestId: request.id,
  siteId: request.siteId,
  requestSummary: "Create the screenshot layout without an image.",
  assumptions: [],
  openQuestions: [],
  targetEntities: ["page:Screenshot test 4"],
  proposedActions: [
    {
      id: "action-1",
      type: "create_draft_post",
      version: 1,
      input: {
        title: "Screenshot test 4",
        post_type: "page",
        post_status: "draft",
        content:
          "<!-- wp:paragraph --><p>Our services</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>SEO / Organic Marketing</p><!-- /wp:paragraph -->"
      },
      targetEntityRefs: ["page:Screenshot test 4"],
      permissionRequirement: "edit_pages",
      riskLevel: "low",
      dryRunCapable: true,
      rollbackSupported: false
    }
  ],
  dependencies: [],
  approvalRequired: false,
  riskLevel: "low",
  rollbackNotes: [],
  validationWarnings: [],
  createdAt: "2026-04-29T11:58:36.740Z",
  updatedAt: "2026-04-29T11:58:36.740Z"
};

const savedPlans: unknown[] = [];

const db = {
  repositories: {
    requests: {
      getById: vi.fn(async () => request),
      save: vi.fn(async () => undefined)
    },
    sites: {
      getById: vi.fn(async () => site)
    },
    discoverySnapshots: {
      getLatest: vi.fn(async () => ({
        id: "discovery-1",
        capabilities: ["sitepilot-create-draft-post"]
      }))
    },
    siteConfigs: {
      listVersions: vi.fn(async () => [])
    },
    requestVisualAnalyses: {
      getByRequestId: vi.fn(async () => null)
    },
    actionPlans: {
      getById: vi.fn(async (id: string) =>
        id === previousStructuredPlan.id ? previousStructuredPlan : null
      ),
      saveFromContract: vi.fn(async (plan: unknown) => {
        savedPlans.push(plan);
      })
    },
    providerUsage: {
      append: vi.fn(async () => undefined)
    },
    auditEntries: {
      append: vi.fn(async () => undefined)
    },
    approvals: {
      save: vi.fn(async () => undefined)
    },
    chatMessages: {
      save: vi.fn(async () => undefined)
    }
  }
};

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => db
}));

vi.mock("../apps/desktop/src/main/planner-context-service.js", () => ({
  buildPlannerContextForThread: vi.fn(async () => ({
    ok: true,
    context: {
      siteId: site.id,
      threadId: request.threadId,
      builtAt: "2026-04-29T11:58:36.740Z",
      siteConfig: null,
      discoverySummary: null,
      messages: [],
      targetSummaries: [],
      priorChanges: []
    }
  }))
}));

vi.mock("../apps/desktop/src/main/image-sourcing-service.js", () => ({
  sourceImagesForActionPlan: vi.fn(async ({ plan }) => plan)
}));

vi.mock("../apps/desktop/src/main/app-secure-storage.js", () => ({
  getSecureStorage: () => ({
    get: vi.fn(async ({ namespace, keyId }) =>
      namespace === "provider" && keyId === "openai" ? "openai-key" : undefined
    )
  })
}));

vi.mock("../apps/desktop/src/main/planner-preferences-service.js", () => ({
  loadPlannerPreferences: vi.fn(async () => ({
    preferredProvider: "openai",
    openaiModel: "gpt-test",
    anthropicModel: "claude-test"
  }))
}));

vi.mock("../apps/desktop/src/main/settings-service.js", () => ({
  loadSitePlannerSettings: vi.fn(async () => ({
    bypassApprovalRequests: false
  }))
}));

vi.mock("@sitepilot/provider-adapters", () => ({
  createOpenAiChatClient: vi.fn(() => ({ providerId: "openai" })),
  createAnthropicChatClient: vi.fn(() => ({ providerId: "anthropic" })),
  estimateUsageCostUsd: vi.fn(() => 0.01)
}));

vi.mock("@sitepilot/services", () => ({
  buildLlmActionPlan: vi.fn(async () => ({
    plan: flattenedPlan,
    usage: { inputTokens: 10, outputTokens: 20 }
  })),
  buildStubActionPlan: vi.fn(),
  enrichActionPlanWithPostLookupFromContext: vi.fn((plan) => plan),
  requestNeedsVisualAnalysisReview: vi.fn(() => false),
  requestVisualAnalysisIsCurrent: vi.fn(() => true)
}));

describe("plan-generation-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedPlans.length = 0;
    db.repositories.requests.getById.mockResolvedValue(request);
    db.repositories.actionPlans.getById.mockResolvedValue(previousStructuredPlan);
  });

  it("preserves structured blocks on a no-image replan instead of flattening to text content", async () => {
    const { generateActionPlanForRequest } = await import(
      "../apps/desktop/src/main/plan-generation-service.js"
    );

    const result = await generateActionPlanForRequest(
      site.id as never,
      request.threadId as never,
      request.id as never
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const savedPlan = savedPlans[0] as typeof flattenedPlan;
    const actionInput = savedPlan.proposedActions[0]?.input as Record<string, unknown>;
    expect(Array.isArray(actionInput.blocks)).toBe(true);
    expect(actionInput.content).toBeUndefined();
    expect(JSON.stringify(actionInput.blocks)).not.toContain('"blockName":"core/image"');
    expect(JSON.stringify(actionInput.blocks)).toContain('"blockName":"core/columns"');
    expect(savedPlan.validationWarnings).toContain(
      "Preserved the previous structured block layout for this revision and removed only the requested block types (image) instead of replacing the whole body with flattened text."
    );
  });

  it("removes only the requested block types on other narrow follow-up revisions", async () => {
    const { preserveStructuredLayoutForNarrowBlockRevision } = await import(
      "../apps/desktop/src/main/plan-generation-service.js"
    );

    const result = preserveStructuredLayoutForNarrowBlockRevision({
      plan: {
        ...flattenedPlan,
        validationWarnings: []
      },
      previousPlan: previousStructuredPlan,
      requestText: "Remove the button block but keep the rest of the layout the same."
    });

    const actionInput = result.proposedActions[0]?.input as Record<string, unknown>;
    const serializedBlocks = JSON.stringify(actionInput.blocks);
    expect(serializedBlocks).toContain('"blockName":"core/columns"');
    expect(serializedBlocks).toContain('"blockName":"core/image"');
    expect(serializedBlocks).not.toContain('"blockName":"core/buttons"');
    expect(serializedBlocks).not.toContain('"blockName":"core/button"');
    expect(result.validationWarnings).toContain(
      "Preserved the previous structured block layout for this revision and removed only the requested block types (button) instead of replacing the whole body with flattened text."
    );
  });
});
