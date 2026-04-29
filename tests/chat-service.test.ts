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
  latestPlanId: "plan-1",
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
      listBySiteId: vi.fn(async () => []),
      getById: vi.fn(async () => request),
      save: vi.fn(async () => undefined)
    },
    requestVisualAnalyses: {
      getByRequestId: vi.fn(async () => null)
    },
    actionPlans: {
      getById: vi.fn(async () => ({
        id: "plan-1",
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            input: { title: "Build a comparison page." }
          }
        ]
      }))
    },
    auditEntries: {
      append: vi.fn(async () => undefined)
    },
    clarificationRounds: {
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
    vi.resetModules();
    vi.clearAllMocks();
    db.repositories.sites.getById.mockResolvedValue(site);
    db.repositories.chatThreads.getById.mockResolvedValue(thread);
    db.repositories.requests.listBySiteId.mockResolvedValue([]);
    db.repositories.requests.getById.mockResolvedValue(request);
    db.repositories.requestVisualAnalyses.getByRequestId.mockResolvedValue(null);
    db.repositories.actionPlans.getById.mockResolvedValue({
      id: "plan-1",
      proposedActions: [
        {
          id: "action-1",
          type: "create_draft_post",
          input: { title: "Build a comparison page." }
        }
      ]
    });
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

  it("does not invalidate the current workflow state for simple confirmation replies", async () => {
    const { amendRequestForThread } = await import(
      "../apps/desktop/src/main/chat-service.js"
    );
    db.repositories.requests.getById.mockResolvedValue({
      ...request,
      status: "drafted"
    });

    const result = await amendRequestForThread(
      site.id as never,
      thread.id as never,
      request.id as never,
      "ok go"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.request.status).toBe("drafted");
    expect(result.request.userPrompt).toBe(request.userPrompt);
    expect(db.repositories.requests.save).not.toHaveBeenCalled();
    expect(db.repositories.chatMessages.save).toHaveBeenCalledWith(
      expect.objectContaining({
        author: { kind: "assistant" },
        body: expect.objectContaining({
          value: expect.stringContaining("Execute plan button")
        })
      })
    );
  });

  it("creates a new request thread when a conversation turn returns research handoff content", async () => {
    vi.doMock("../apps/desktop/src/main/conversation-service.js", () => ({
      buildConversationReply: vi.fn(async () => ({
        text: 'Fetched Example page and created a new request thread: Research: Example page.',
        requestPrompt: "Use this external page as source material.",
        requestThreadTitle: "Research: Example page"
      }))
    }));

    const conversationThread = {
      ...thread,
      type: "conversation"
    };
    db.repositories.chatThreads.getById.mockResolvedValue(conversationThread);
    db.repositories.chatThreads.save.mockImplementation(async (value) => value);

    const { postChatMessage } = await import(
      "../apps/desktop/src/main/chat-service.js"
    );

    const result = await postChatMessage(
      site.id as never,
      conversationThread.id as never,
      "Use the text from https://example.com in a new request."
    );

    expect(result.ok).toBe(true);
    expect(db.repositories.chatThreads.save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Research: Example page",
        type: "general_request"
      })
    );
    expect(db.repositories.requests.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: "Use this external page as source material."
      })
    );
  });
});
