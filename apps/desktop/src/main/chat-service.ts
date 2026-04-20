import { randomUUID } from "node:crypto";

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
import { analyzeClarification } from "@sitepilot/services";

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

  await db.repositories.chatThreads.save({
    ...t.thread,
    updatedAt: ts
  });

  if (clarificationRound !== undefined) {
    return { ok: true, request, clarificationRound };
  }
  return { ok: true, request };
}
