import { beforeEach, describe, expect, it, vi } from "vitest";

const site = {
  id: "site-1",
  activationStatus: "active"
};

const thread = {
  id: "thread-1",
  siteId: site.id,
  title: "Request",
  type: "general_request",
  createdAt: "2026-04-24T10:00:00.000Z",
  updatedAt: "2026-04-24T10:00:00.000Z"
};

const request = {
  id: "request-1",
  siteId: site.id,
  threadId: thread.id,
  requestedBy: {
    userProfileId: "local-operator",
    appRole: "requester",
    siteRoles: ["request"]
  },
  status: "approved",
  userPrompt: "Build a comparison page.",
  createdAt: "2026-04-24T10:00:00.000Z",
  updatedAt: "2026-04-24T10:00:00.000Z"
};

const db = {
  repositories: {
    sites: {
      getById: vi.fn(async () => site)
    },
    chatThreads: {
      getById: vi.fn(async () => thread),
      save: vi.fn(async () => undefined)
    },
    requests: {
      getById: vi.fn(async () => request),
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

describe("chat service request revision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.repositories.sites.getById.mockResolvedValue(site);
    db.repositories.chatThreads.getById.mockResolvedValue(thread);
    db.repositories.requests.getById.mockResolvedValue(request);
  });

  it("allows revising an approved request back to a planable state", async () => {
    const { amendRequestForThread } = await import(
      "../apps/desktop/src/main/chat-service.js"
    );

    const result = await amendRequestForThread(
      site.id as never,
      thread.id as never,
      request.id as never,
      "Do not use the summary block."
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.request.status).toBe("new");
    expect(result.request.userPrompt).toContain("Do not use the summary block.");
    expect(db.repositories.requests.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: request.id,
        status: "new"
      })
    );
  });

  it("still blocks revisions while execution is running", async () => {
    const { amendRequestForThread } = await import(
      "../apps/desktop/src/main/chat-service.js"
    );
    db.repositories.requests.getById.mockResolvedValue({
      ...request,
      status: "executing"
    });

    const result = await amendRequestForThread(
      site.id as never,
      thread.id as never,
      request.id as never,
      "Use paragraphs instead."
    );

    expect(result).toEqual({
      ok: false,
      code: "request_locked",
      message:
        "This request is executing right now. Wait for it to finish before revising the request."
    });
  });
});
