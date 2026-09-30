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
  createdAt: "2026-04-28T10:00:00.000Z",
  updatedAt: "2026-04-28T10:00:00.000Z"
};

const db = {
  repositories: {
    requests: {
      getById: vi.fn(
        async (): Promise<Record<string, unknown> | null> => request
      ),
      save: vi.fn(async () => undefined)
    },
    actionPlans: {
      getById: vi.fn(async (): Promise<Record<string, unknown> | null> => null)
    },
    executionRuns: {
      getById: vi.fn(async (): Promise<Record<string, unknown> | null> => null)
    }
  }
};

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => db
}));

async function loadBundle(overrides: Record<string, unknown> = {}) {
  db.repositories.requests.getById.mockResolvedValue({
    ...request,
    ...overrides
  });
  const { getRequestBundleForThread } =
    await import("../apps/desktop/src/main/request-bundle-service.js");
  return getRequestBundleForThread({
    siteId: "site-1" as never,
    threadId: "thread-1" as never,
    requestId: "request-1" as never
  });
}

describe("request-bundle-service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    db.repositories.actionPlans.getById.mockResolvedValue(null);
    db.repositories.executionRuns.getById.mockResolvedValue(null);
  });

  it("returns a v2 request with no legacy summary, and never rewrites its status", async () => {
    const result = await loadBundle();

    expect(result).toMatchObject({
      ok: true,
      request: { id: "request-1" },
      legacyV1: null
    });
    expect(db.repositories.requests.save).not.toHaveBeenCalled();
    expect(db.repositories.actionPlans.getById).not.toHaveBeenCalled();
  });

  it("summarises a request made with the removed v1 engine", async () => {
    db.repositories.actionPlans.getById.mockResolvedValue({
      id: "plan-1",
      proposedActions: [{ id: "a1" }, { id: "a2" }]
    });
    db.repositories.executionRuns.getById.mockResolvedValue({
      id: "run-1",
      status: "failed"
    });

    const result = await loadBundle({
      status: "archived",
      latestPlanId: "plan-1",
      latestExecutionRunId: "run-1"
    });

    expect(result).toMatchObject({
      ok: true,
      legacyV1: { plannedActionCount: 2, lastRunStatus: "failed" }
    });
    expect(db.repositories.requests.save).not.toHaveBeenCalled();
  });

  it("still summarises a v1 request whose plan can no longer be read", async () => {
    db.repositories.actionPlans.getById.mockRejectedValue(new Error("bad row"));

    const result = await loadBundle({ latestPlanId: "plan-1" });

    expect(result).toMatchObject({
      ok: true,
      legacyV1: { plannedActionCount: 0 }
    });
  });

  it("refuses a request from another thread", async () => {
    const result = await loadBundle({ threadId: "thread-2" });

    expect(result).toMatchObject({ ok: false, code: "thread_mismatch" });
  });
});
