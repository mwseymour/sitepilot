import { randomUUID } from "node:crypto";

import type { ActionPlan as ContractActionPlan } from "@sitepilot/contracts";
import type {
  ActorRef,
  AuditEntryId,
  ChatMessage,
  ChatThread,
  ClarificationRound,
  ChatMessageId,
  ChatThreadId,
  ClarificationRoundId,
  Request,
  RequestId,
  SiteId,
  UserProfileId
} from "@sitepilot/domain";
import {
  analyzeClarification,
  canResolveActionViaPostLookup
} from "@sitepilot/services";
import { actionToMcpToolCall } from "@sitepilot/services/mcp-action-map";

import { getDatabase } from "./app-database.js";

export const DEFAULT_OPERATOR: ActorRef = {
  userProfileId: "local-operator" as UserProfileId,
  appRole: "requester",
  siteRoles: ["request"]
};

function nowIso(): string {
  return new Date().toISOString();
}

async function requireActiveSite(
  siteId: SiteId
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  if (site.activationStatus !== "active") {
    return {
      ok: false,
      code: "site_not_active",
      message: "Activate site configuration before using chat."
    };
  }
  return { ok: true };
}

async function loadThreadForSite(
  threadId: ChatThreadId,
  siteId: SiteId
): Promise<
  | { ok: true; thread: ChatThread }
  | { ok: false; code: string; message: string }
> {
  const db = getDatabase();
  const thread = await db.repositories.chatThreads.getById(threadId);
  if (!thread) {
    return {
      ok: false,
      code: "thread_not_found",
      message: "Thread not found."
    };
  }
  if (thread.siteId !== siteId) {
    return {
      ok: false,
      code: "thread_site_mismatch",
      message: "Thread does not belong to this site."
    };
  }
  return { ok: true, thread };
}

async function saveThreadUpdatedAt(thread: ChatThread, updatedAt: string) {
  const db = getDatabase();
  await db.repositories.chatThreads.save({
    ...thread,
    updatedAt
  });
}

async function saveAssistantThreadMessage(input: {
  threadId: ChatThreadId;
  siteId: SiteId;
  requestId?: RequestId;
  text: string;
  createdAt: string;
}): Promise<void> {
  const db = getDatabase();
  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId: input.threadId,
    siteId: input.siteId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    author: { kind: "assistant" },
    body: { format: "plain_text", value: input.text },
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

function countRunnableActions(plan: ContractActionPlan | null): number {
  if (!plan) {
    return 0;
  }
  return plan.proposedActions.filter(
    (action: ContractActionPlan["proposedActions"][number]) =>
      actionToMcpToolCall(action.type, action.input, true) !== null ||
      canResolveActionViaPostLookup(action.type, action.input)
  ).length;
}

async function buildThreadReply(
  siteId: SiteId,
  threadId: ChatThreadId,
  text: string
): Promise<{ requestId?: RequestId; text: string }> {
  const db = getDatabase();
  const requests = await db.repositories.requests.listByThreadId(threadId);
  const request = requests.at(-1);

  if (!request || request.siteId !== siteId) {
    return {
      text:
        "I recorded that note, but there is no active request in this thread yet. Start a new request from the composer below."
    };
  }

  const plan =
    request.latestPlanId !== undefined
      ? await db.repositories.actionPlans.getById(request.latestPlanId)
      : null;
  const runnableCount = countRunnableActions(plan);
  const normalized = text.trim().toLowerCase();
  const asksToRun =
    /(^|\b)(do it|run it|execute|ship it|go ahead|start|publish|dry run|dry-run)(\b|$)/i.test(
      normalized
    );

  switch (request.status) {
    case "awaiting_approval":
      return {
        requestId: request.id,
        text:
          "This request is still waiting for approval. Open Approvals to unlock execution."
      };
    case "approved":
      if (runnableCount === 0) {
        return {
          requestId: request.id,
          text:
            "This plan is approved, but I cannot run it yet because none of its actions map to an MCP tool."
        };
      }
      if (asksToRun) {
        return {
          requestId: request.id,
          text:
            runnableCount === 1
              ? "This plan is ready. Use the Execute plan button in the Current request panel."
              : "This plan is ready. Use the action buttons in the Planned actions list to run each step."
        };
      }
      return {
        requestId: request.id,
        text:
          runnableCount === 1
            ? "Note recorded. This plan is approved and ready to run from the Current request panel."
            : "Note recorded. This plan is approved. Use the action buttons in the Planned actions list to run each step."
      };
    case "executing":
      return {
        requestId: request.id,
        text:
          "Execution is already in progress. I will keep posting updates in this thread."
      };
    case "completed":
      return {
        requestId: request.id,
        text:
          "That request is already completed. Start a new request if you want to make another change."
      };
    default:
      return {
        requestId: request.id,
        text:
          "Note recorded. Review the current request panel below for the next step."
      };
  }
}

export type ChatThreadsResult =
  | { ok: true; threads: ChatThread[] }
  | { ok: false; code: string; message: string };

export async function listChatThreadsForSite(
  siteId: SiteId
): Promise<ChatThreadsResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const db = getDatabase();
  const threads = await db.repositories.chatThreads.listBySiteId(siteId);
  return { ok: true, threads };
}

export type CreateThreadResult =
  | { ok: true; thread: ChatThread }
  | { ok: false; code: string; message: string };

export async function createChatThreadForSite(
  siteId: SiteId,
  params: { title: string; type?: ChatThread["type"] }
): Promise<CreateThreadResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const db = getDatabase();
  const t = nowIso();
  const thread: ChatThread = {
    id: randomUUID() as ChatThreadId,
    siteId,
    title: params.title,
    type: params.type ?? "general_request",
    createdAt: t,
    updatedAt: t
  };
  await db.repositories.chatThreads.save(thread);
  return { ok: true, thread };
}

export type ListMessagesResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; code: string; message: string };

export async function listChatMessagesForThread(
  siteId: SiteId,
  threadId: ChatThreadId
): Promise<ListMessagesResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }
  const db = getDatabase();
  const messages = await db.repositories.chatMessages.listByThreadId(threadId);
  return { ok: true, messages };
}

export type PostMessageResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; code: string; message: string };

export async function postChatMessage(
  siteId: SiteId,
  threadId: ChatThreadId,
  text: string
): Promise<PostMessageResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }
  const db = getDatabase();
  const ts = nowIso();
  const message: ChatMessage = {
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    author: DEFAULT_OPERATOR,
    body: { format: "plain_text", value: text },
    createdAt: ts,
    updatedAt: ts
  };
  await db.repositories.chatMessages.save(message);
  const assistantReply = await buildThreadReply(siteId, threadId, text);
  await saveAssistantThreadMessage({
    threadId,
    siteId,
    ...(assistantReply.requestId !== undefined
      ? { requestId: assistantReply.requestId }
      : {}),
    text: assistantReply.text,
    createdAt: ts
  });
  await db.repositories.chatThreads.save({
    ...t.thread,
    updatedAt: ts
  });
  return { ok: true, message };
}

export type CreateRequestResult =
  | {
      ok: true;
      request: Request;
      clarificationRound?: ClarificationRound;
    }
  | { ok: false; code: string; message: string };

export async function createTypedRequestForThread(
  siteId: SiteId,
  threadId: ChatThreadId,
  userPrompt: string
): Promise<CreateRequestResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }

  const db = getDatabase();
  const recent = await db.repositories.requests.listBySiteId(siteId);
  const recentPrompts = recent.map((r: Request) => r.userPrompt).slice(0, 50);

  const analysis = analyzeClarification({
    userPrompt,
    recentPromptsForSite: recentPrompts
  });

  const ts = nowIso();
  const status: Request["status"] = analysis.needsClarification
    ? "clarifying"
    : "new";

  const request: Request = {
    id: randomUUID() as RequestId,
    siteId,
    threadId,
    requestedBy: DEFAULT_OPERATOR,
    status,
    userPrompt,
    createdAt: ts,
    updatedAt: ts
  };

  await db.repositories.requests.save(request);

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId,
    requestId: request.id,
    eventType: "request_created",
    actor: DEFAULT_OPERATOR,
    metadata: { promptLength: userPrompt.length },
    createdAt: ts,
    updatedAt: ts
  });

  const userMessage: ChatMessage = {
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    author: DEFAULT_OPERATOR,
    body: { format: "plain_text", value: userPrompt },
    requestId: request.id,
    createdAt: ts,
    updatedAt: ts
  };
  await db.repositories.chatMessages.save(userMessage);

  if (!analysis.needsClarification) {
    await db.repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId,
      siteId,
      author: { kind: "assistant" },
      body: {
        format: "plain_text",
        value:
          "Request recorded. Review it below, then generate an action plan when you're ready."
      },
      requestId: request.id,
      createdAt: ts,
      updatedAt: ts
    });
  }

  let clarificationRound: ClarificationRound | undefined;

  if (analysis.duplicateWarnings.length > 0) {
    await db.repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId,
      siteId,
      author: { kind: "system" },
      body: {
        format: "plain_text",
        value: analysis.duplicateWarnings.join("\n")
      },
      createdAt: ts,
      updatedAt: ts
    });
  }

  if (analysis.needsClarification) {
    clarificationRound = {
      id: randomUUID() as ClarificationRoundId,
      requestId: request.id,
      siteId,
      questions: analysis.questions,
      answers: [],
      createdAt: ts,
      updatedAt: ts
    };
    await db.repositories.clarificationRounds.save(clarificationRound);

    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId,
      requestId: request.id,
      eventType: "clarification_requested",
      actor: { kind: "assistant" },
      metadata: { questionCount: analysis.questions.length },
      createdAt: ts,
      updatedAt: ts
    });

    const clarifyBody = `More detail is needed before planning:\n${analysis.questions
      .map((q: string, i: number) => `${i + 1}. ${q}`)
      .join("\n")}`;

    await db.repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId,
      siteId,
      author: { kind: "assistant" },
      body: { format: "plain_text", value: clarifyBody },
      createdAt: ts,
      updatedAt: ts
    });
  }

  await saveThreadUpdatedAt(t.thread, ts);

  if (clarificationRound !== undefined) {
    return { ok: true, request, clarificationRound };
  }
  return { ok: true, request };
}

export async function answerClarificationForRequest(
  siteId: SiteId,
  threadId: ChatThreadId,
  requestId: RequestId,
  answer: string
): Promise<CreateRequestResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }

  const db = getDatabase();
  const request = await db.repositories.requests.getById(requestId);
  if (!request || request.siteId !== siteId || request.threadId !== threadId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request not found for this thread."
    };
  }

  const rounds = await db.repositories.clarificationRounds.listByRequestId(
    requestId
  );
  const activeRound = [...rounds]
    .reverse()
    .find((round) => round.resolvedAt === undefined);
  if (!activeRound) {
    return {
      ok: false,
      code: "clarification_not_pending",
      message: "This request is not waiting on clarification."
    };
  }

  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "clarification_empty",
      message: "Clarification response cannot be empty."
    };
  }

  const ts = nowIso();
  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    requestId,
    author: DEFAULT_OPERATOR,
    body: { format: "plain_text", value: trimmed },
    createdAt: ts,
    updatedAt: ts
  });

  await db.repositories.clarificationRounds.save({
    ...activeRound,
    answers: [...activeRound.answers, trimmed],
    resolvedAt: ts,
    updatedAt: ts
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId,
    requestId,
    eventType: "clarification_answered",
    actor: DEFAULT_OPERATOR,
    metadata: { answerLength: trimmed.length },
    createdAt: ts,
    updatedAt: ts
  });

  const mergedPrompt = `${request.userPrompt}\n\nClarification:\n${trimmed}`;
  const recent = (await db.repositories.requests.listBySiteId(siteId))
    .filter((item: Request) => item.id !== requestId)
    .map((item: Request) => item.userPrompt)
    .slice(0, 50);
  const analysis = analyzeClarification({
    userPrompt: mergedPrompt,
    recentPromptsForSite: recent
  });

  let clarificationRound: ClarificationRound | undefined;
  let nextStatus: Request["status"] = analysis.needsClarification
    ? "clarifying"
    : "new";

  const updatedRequest: Request = {
    ...request,
    status: nextStatus,
    userPrompt: mergedPrompt,
    updatedAt: ts
  };
  await db.repositories.requests.save(updatedRequest);

  if (analysis.duplicateWarnings.length > 0) {
    await db.repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId,
      siteId,
      author: { kind: "system" },
      body: {
        format: "plain_text",
        value: analysis.duplicateWarnings.join("\n")
      },
      createdAt: ts,
      updatedAt: ts
    });
  }

  if (analysis.needsClarification) {
    clarificationRound = {
      id: randomUUID() as ClarificationRoundId,
      requestId,
      siteId,
      questions: analysis.questions,
      answers: [],
      createdAt: ts,
      updatedAt: ts
    };
    await db.repositories.clarificationRounds.save(clarificationRound);
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId,
      requestId,
      eventType: "clarification_requested",
      actor: { kind: "assistant" },
      metadata: { questionCount: analysis.questions.length },
      createdAt: ts,
      updatedAt: ts
    });
    await db.repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId,
      siteId,
      requestId,
      author: { kind: "assistant" },
      body: {
        format: "plain_text",
        value: `Thanks. I still need a bit more detail:\n${analysis.questions
          .map((q: string, i: number) => `${i + 1}. ${q}`)
          .join("\n")}`
      },
      createdAt: ts,
      updatedAt: ts
    });
  } else {
    await db.repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId,
      siteId,
      requestId,
      author: { kind: "assistant" },
      body: {
        format: "plain_text",
        value:
          "Clarification recorded. Review the updated request below, then generate an action plan when you're ready."
      },
      createdAt: ts,
      updatedAt: ts
    });
  }

  await saveThreadUpdatedAt(t.thread, ts);

  if (clarificationRound !== undefined) {
    return { ok: true, request: updatedRequest, clarificationRound };
  }
  return { ok: true, request: updatedRequest };
}

export async function amendRequestForThread(
  siteId: SiteId,
  threadId: ChatThreadId,
  requestId: RequestId,
  text: string
): Promise<CreateRequestResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }

  const db = getDatabase();
  const request = await db.repositories.requests.getById(requestId);
  if (!request || request.siteId !== siteId || request.threadId !== threadId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request not found for this thread."
    };
  }
  if (request.status === "clarifying") {
    return {
      ok: false,
      code: "clarification_pending",
      message: "Answer the clarification question instead of amending the request."
    };
  }
  if (
    request.status === "awaiting_approval" ||
    request.status === "approved" ||
    request.status === "executing"
  ) {
    return {
      ok: false,
      code: "request_locked",
      message: "This request is already in approval or execution. Start a new thread for a new task."
    };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "request_empty",
      message: "Request update cannot be empty."
    };
  }

  const ts = nowIso();
  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    requestId,
    author: DEFAULT_OPERATOR,
    body: { format: "plain_text", value: trimmed },
    createdAt: ts,
    updatedAt: ts
  });

  const updatedRequest: Request = {
    id: request.id,
    siteId: request.siteId,
    threadId: request.threadId,
    requestedBy: request.requestedBy,
    status: "new",
    userPrompt: `${request.userPrompt}\n\nAdditional context:\n${trimmed}`,
    ...(request.latestExecutionRunId !== undefined
      ? { latestExecutionRunId: request.latestExecutionRunId }
      : {}),
    createdAt: request.createdAt,
    updatedAt: ts
  };
  await db.repositories.requests.save(updatedRequest);

  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    requestId,
    author: { kind: "assistant" },
    body: {
      format: "plain_text",
      value:
        "Added to the current request. Review it below, then generate an action plan when you're ready."
    },
    createdAt: ts,
    updatedAt: ts
  });

  await saveThreadUpdatedAt(t.thread, ts);
  return { ok: true, request: updatedRequest };
}
