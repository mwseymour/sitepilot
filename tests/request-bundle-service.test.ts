import { beforeEach, describe, expect, it, vi } from "vitest";

const request = {
  id: "request-1",
  siteId: "site-1",
  threadId: "thread-1",
  requestedBy: {
    userProfileId: "local-operator",
    appRole: "requester",
    siteRoles: ["request"]
  },
  status: "new",
  userPrompt: "Create a draft page with a burger image.",
  latestPlanId: "plan-1",
  createdAt: "2026-04-28T10:00:00.000Z",
  updatedAt: "2026-04-28T10:00:00.000Z"
};

const plan = {
  id: "plan-1",
  requestId: request.id,
  siteId: request.siteId,
  requestSummary: "Create a draft page with a burger image.",
  assumptions: [],
  openQuestions: ["None."],
  targetEntities: ["page: Big Beefy Boys"],
  proposedActions: [
    {
      id: "action-1",
      type: "create_draft_post",
      version: 1,
      input: {
        title: "Big Beefy Boys",
        post_type: "page",
        post_status: "draft",
        content: "<!-- wp:paragraph --><p>Hello.</p><!-- /wp:paragraph -->"
      },
      targetEntityRefs: ["page: Big Beefy Boys"],
      permissionRequirement: "create_draft_post",
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
  createdAt: "2026-04-28T10:00:00.000Z",
  updatedAt: "2026-04-28T10:00:00.000Z"
};

const db = {
  repositories: {
    requests: {
      getById: vi.fn(async () => request),
      save: vi.fn(async () => undefined)
    },
    actionPlans: {
      getById: vi.fn(async () => plan)
    },
    approvals: {
      listByRequestId: vi.fn(async () => [])
    },
    executionRuns: {
      getById: vi.fn(async () => null)
    },
    toolInvocations: {
      listByExecutionRunId: vi.fn(async () => [])
    },
    discoverySnapshots: {
      getLatest: vi.fn(async () => ({
        id: "discovery-1",
        capabilities: ["read", "edit_drafts"]
      }))
    },
    siteConfigs: {
      listVersions: vi.fn(async () => [
        {
          version: 1,
          document: {
            requiredSectionsComplete: true,
            activationStatus: "active",
            sections: {
              approvalPolicy: {
                publishRequiresApproval: true,
                menuChangesRequireApproval: true,
                autoApproveCategories: []
              }
            }
          }
        }
      ])
    }
  }
};

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => db
}));

vi.mock("../apps/desktop/src/main/app-secure-storage.js", () => ({
  getSecureStorage: () => ({})
}));

vi.mock("../apps/desktop/src/main/settings-service.js", () => ({
  loadSitePlannerSettings: vi.fn(async () => ({
    bypassApprovalRequests: false
  }))
}));

describe("request-bundle-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.repositories.requests.getById.mockResolvedValue(request);
    db.repositories.actionPlans.getById.mockResolvedValue(plan);
  });

  it("reconciles stale request status from the latest plan validation", async () => {
    const { getRequestBundleForThread } = await import(
      "../apps/desktop/src/main/request-bundle-service.js"
    );

    const result = await getRequestBundleForThread({
      siteId: request.siteId as never,
      threadId: request.threadId as never,
      requestId: request.id as never
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.request.status).toBe("approved");
    expect(db.repositories.requests.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: request.id,
        status: "approved"
      })
    );
  });
});
