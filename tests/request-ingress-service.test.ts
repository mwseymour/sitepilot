import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Request } from "@sitepilot/domain";

const db = {
  repositories: {
    sites: {
      getById: vi.fn()
    },
    chatThreads: {
      getById: vi.fn()
    },
    requests: {
      listByThreadId: vi.fn()
    }
  }
};

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => db
}));

vi.mock("../apps/desktop/src/main/chat-service.js", () => ({
  createTypedRequestForThread: vi.fn(),
  amendRequestForThread: vi.fn(),
  answerClarificationForRequest: vi.fn(),
  postChatMessage: vi.fn()
}));

vi.mock("../apps/desktop/src/main/gutenberg-v2-chat-service.js", () => ({
  continueGutenbergV2AfterFollowUp: vi.fn(),
  hasGutenbergV2RequestMapping: vi.fn()
}));

vi.mock("../apps/desktop/src/main/plan-generation-service.js", () => ({
  generateActionPlanForRequest: vi.fn()
}));

import {
  amendRequestForThread,
  answerClarificationForRequest,
  createTypedRequestForThread,
  postChatMessage
} from "../apps/desktop/src/main/chat-service.js";
import {
  continueGutenbergV2AfterFollowUp,
  hasGutenbergV2RequestMapping
} from "../apps/desktop/src/main/gutenberg-v2-chat-service.js";
import { generateActionPlanForRequest } from "../apps/desktop/src/main/plan-generation-service.js";
import {
  ingestRequestThreadMessage,
  selectOpenRequestForFollowUp
} from "../apps/desktop/src/main/request-ingress-service.js";

const site = {
  id: "site-1",
  activationStatus: "active"
};

const thread = {
  id: "thread-1",
  siteId: site.id,
  title: "Request",
  type: "content_creation",
  createdAt: "2026-04-24T10:00:00.000Z",
  updatedAt: "2026-04-24T10:00:00.000Z"
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "request-1",
    siteId: site.id,
    threadId: thread.id,
    requestedBy: {
      userProfileId: "local-operator",
      appRole: "requester",
      siteRoles: ["request"]
    },
    status: "new",
    userPrompt: "Create a post with 2 carrots.",
    createdAt: "2026-04-24T10:00:00.000Z",
    updatedAt: "2026-04-24T10:00:00.000Z",
    ...overrides
  } as Request;
}

describe("selectOpenRequestForFollowUp", () => {
  it("picks the latest open request and ignores completed work", () => {
    const completed = makeRequest({
      id: "request-old",
      status: "completed",
      createdAt: "2026-04-24T09:00:00.000Z"
    });
    const open = makeRequest({
      id: "request-open",
      status: "awaiting_approval",
      createdAt: "2026-04-24T10:00:00.000Z"
    });
    expect(selectOpenRequestForFollowUp([completed, open])?.id).toBe(
      "request-open"
    );
    expect(selectOpenRequestForFollowUp([completed])).toBeNull();
  });
});

describe("ingestRequestThreadMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.repositories.sites.getById.mockResolvedValue(site);
    db.repositories.chatThreads.getById.mockResolvedValue(thread);
    db.repositories.requests.listByThreadId.mockResolvedValue([]);
    (hasGutenbergV2RequestMapping as Mock).mockReturnValue(false);
  });

  it("creates a request on the first message and amends the same request on the next", async () => {
    const created = makeRequest({ status: "new" });
    (createTypedRequestForThread as Mock).mockResolvedValue({
      ok: true,
      request: created
    });

    const first = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Create a post with 2 carrots."
    });

    expect(first).toMatchObject({
      ok: true,
      outcome: "created",
      continued: false,
      request: { id: "request-1" }
    });
    expect(createTypedRequestForThread).toHaveBeenCalledTimes(1);
    expect(amendRequestForThread).not.toHaveBeenCalled();

    const open = makeRequest({
      status: "awaiting_approval",
      userPrompt: "Create a post with 2 carrots."
    });
    db.repositories.requests.listByThreadId.mockResolvedValue([open]);
    (amendRequestForThread as Mock).mockResolvedValue({
      ok: true,
      request: makeRequest({
        status: "new",
        userPrompt: "Create a post with 2 carrots and 1 plum."
      })
    });

    const second = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Also add 1 plum."
    });

    expect(second).toMatchObject({
      ok: true,
      outcome: "amended",
      request: { id: "request-1" }
    });
    expect(amendRequestForThread).toHaveBeenCalledWith(
      site.id,
      thread.id,
      "request-1",
      "Also add 1 plum.",
      undefined
    );
    expect(createTypedRequestForThread).toHaveBeenCalledTimes(1);
  });

  it("starts a new request after the previous one completed", async () => {
    db.repositories.requests.listByThreadId.mockResolvedValue([
      makeRequest({ status: "completed" })
    ]);
    (createTypedRequestForThread as Mock).mockResolvedValue({
      ok: true,
      request: makeRequest({ id: "request-2" as never, status: "new" })
    });

    const result = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Now write a plum recipe."
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "created",
      request: { id: "request-2" }
    });
    expect(amendRequestForThread).not.toHaveBeenCalled();
    expect(createTypedRequestForThread).toHaveBeenCalledTimes(1);
  });

  it("notes a message while a request is executing instead of creating another", async () => {
    const executing = makeRequest({ status: "executing" });
    db.repositories.requests.listByThreadId.mockResolvedValue([executing]);
    (postChatMessage as Mock).mockResolvedValue({
      ok: true,
      message: { id: "msg-1" }
    });

    const result = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Hang on, one more thought."
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "noted",
      continued: false,
      request: { id: "request-1" }
    });
    expect(postChatMessage).toHaveBeenCalledTimes(1);
    expect(createTypedRequestForThread).not.toHaveBeenCalled();
    expect(amendRequestForThread).not.toHaveBeenCalled();
  });

  it("answers clarification on the same request", async () => {
    db.repositories.requests.listByThreadId.mockResolvedValue([
      makeRequest({ status: "clarifying" })
    ]);
    (answerClarificationForRequest as Mock).mockResolvedValue({
      ok: true,
      request: makeRequest({ status: "new" })
    });

    const result = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Make it a draft post."
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "clarified",
      request: { id: "request-1" }
    });
    expect(answerClarificationForRequest).toHaveBeenCalledWith(
      site.id,
      thread.id,
      "request-1",
      "Make it a draft post.",
      undefined
    );
    expect(createTypedRequestForThread).not.toHaveBeenCalled();
  });

  it("regenerates a Gutenberg v2 candidate after a follow-up on the same request", async () => {
    db.repositories.requests.listByThreadId.mockResolvedValue([
      makeRequest({ status: "awaiting_approval" })
    ]);
    (hasGutenbergV2RequestMapping as Mock).mockReturnValue(true);
    (amendRequestForThread as Mock).mockResolvedValue({
      ok: true,
      request: makeRequest({ status: "new" })
    });
    (continueGutenbergV2AfterFollowUp as Mock).mockResolvedValue({
      ok: true,
      state: {
        requestId: "request-1",
        state: "review_ready"
      }
    });

    const result = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Take one carrot away."
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "amended",
      continued: true
    });
    expect(continueGutenbergV2AfterFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: site.id,
        requestId: "request-1",
        note: "Take one carrot away."
      })
    );
    expect(generateActionPlanForRequest).not.toHaveBeenCalled();
  });

  it("regenerates a v1 plan when a follow-up changes a request that already has one", async () => {
    db.repositories.requests.listByThreadId.mockResolvedValue([
      makeRequest({ status: "drafted", latestPlanId: "plan-1" as never })
    ]);
    (amendRequestForThread as Mock).mockResolvedValue({
      ok: true,
      request: makeRequest({
        status: "new",
        latestPlanId: "plan-1" as never
      })
    });
    (generateActionPlanForRequest as Mock).mockResolvedValue({
      ok: true,
      plan: { id: "plan-2" },
      validation: { kind: "pass" }
    });

    const result = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "Use a heading instead of a list."
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "amended",
      continued: true,
      plan: { id: "plan-2" }
    });
    expect(generateActionPlanForRequest).toHaveBeenCalledWith(
      site.id,
      thread.id,
      "request-1"
    );
  });

  it("does not regenerate after a confirmation that leaves the request unchanged", async () => {
    db.repositories.requests.listByThreadId.mockResolvedValue([
      makeRequest({ status: "drafted", latestPlanId: "plan-1" as never })
    ]);
    (amendRequestForThread as Mock).mockResolvedValue({
      ok: true,
      request: makeRequest({
        status: "drafted",
        latestPlanId: "plan-1" as never
      })
    });

    const result = await ingestRequestThreadMessage({
      siteId: site.id as never,
      threadId: thread.id as never,
      text: "ok go"
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "amended",
      continued: false
    });
    expect(generateActionPlanForRequest).not.toHaveBeenCalled();
    expect(continueGutenbergV2AfterFollowUp).not.toHaveBeenCalled();
  });
});
