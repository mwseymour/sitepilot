import { randomUUID } from "node:crypto";

import type { ImageAttachmentPayload } from "@sitepilot/contracts";
import type {
  AuditEntryId,
  ChatMessage,
  ChatThread,
  ClarificationRound,
  ChatMessageId,
  ChatThreadId,
  Request,
  RequestId,
  SiteId
} from "@sitepilot/domain";
import { mergeRevisedRequestPrompt } from "@sitepilot/services";
import {
  createAnthropicChatClient,
  createOpenAiChatClient
} from "@sitepilot/provider-adapters";

import { getDatabase } from "./app-database.js";
import { currentActor, currentCallContext } from "./call-context.js";
import { getSecureStorage } from "./app-secure-storage.js";
import { buildConversationReply } from "./conversation-service.js";
import { loadPlannerPreferences } from "./planner-preferences-service.js";

export { DEFAULT_OPERATOR } from "./call-context.js";

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

function normalizeAttachments(
  attachments: ImageAttachmentPayload[] | undefined
): ImageAttachmentPayload[] {
  return attachments ?? [];
}

function mergeAttachments(
  existing: ImageAttachmentPayload[] | undefined,
  incoming: ImageAttachmentPayload[] | undefined
): ImageAttachmentPayload[] | undefined {
  const merged = [...normalizeAttachments(existing), ...normalizeAttachments(incoming)];
  return merged.length > 0 ? merged : undefined;
}

async function mergeFollowUpIntoRequestPrompt(
  currentPrompt: string,
  followUp: string
): Promise<string> {
  try {
    const storage = getSecureStorage();
    const prefs = await loadPlannerPreferences(storage);
    const openaiKey = await storage.get({
      namespace: "provider",
      keyId: "openai"
    });
    const anthropicKey = await storage.get({
      namespace: "provider",
      keyId: "anthropic"
    });
    const openai =
      openaiKey !== undefined
        ? {
            client: createOpenAiChatClient(openaiKey),
            model: prefs.openaiModel
          }
        : undefined;
    const anthropic =
      anthropicKey !== undefined
        ? {
            client: createAnthropicChatClient(anthropicKey),
            model: prefs.anthropicModel
          }
        : undefined;
    const chosen =
      prefs.preferredProvider === "anthropic"
        ? (anthropic ?? openai)
        : (openai ?? anthropic);
    return mergeRevisedRequestPrompt({
      currentPrompt,
      followUp,
      ...(chosen === undefined
        ? {}
        : { client: chosen.client, model: chosen.model })
    });
  } catch {
    return mergeRevisedRequestPrompt({ currentPrompt, followUp });
  }
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

async function createRequestRecordForThread(input: {
  siteId: SiteId;
  thread: ChatThread;
  userPrompt: string;
  attachments?: ImageAttachmentPayload[];
}): Promise<CreateRequestResult> {
  const db = getDatabase();
  const ts = nowIso();
  // Requests carry an explicit v2 operation and target, so there is nothing to
  // clarify up front.
  const status: Request["status"] = "new";

  const request: Request = {
    id: randomUUID() as RequestId,
    siteId: input.siteId,
    threadId: input.thread.id,
    requestedBy: currentActor(),
    status,
    userPrompt: input.userPrompt,
    ...(input.attachments !== undefined && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    createdAt: ts,
    updatedAt: ts
  };

  await db.repositories.requests.save(request);

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: request.id,
    eventType: "request_created",
    actor: currentActor(),
    metadata: { promptLength: input.userPrompt.length },
    createdAt: ts,
    updatedAt: ts
  });

  const userMessage: ChatMessage = {
    id: randomUUID() as ChatMessageId,
    threadId: input.thread.id,
    siteId: input.siteId,
    author: currentActor(),
    body: { format: "plain_text", value: input.userPrompt },
    ...(input.attachments !== undefined && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    requestId: request.id,
    createdAt: ts,
    updatedAt: ts
  };
  await db.repositories.chatMessages.save(userMessage);

  await saveThreadUpdatedAt(input.thread, ts);
  return { ok: true, request };
}

/**
 * Starts a v2 new-draft request from a Conversation's research handoff, the
 * same way the MCP server's create_request does. It runs in the background so
 * the Conversation reply returns at once. Planning stops at review, so nothing
 * is written until someone approves. A failure is posted in the new thread.
 */
function startResearchDraftRequest(
  siteId: SiteId,
  thread: ChatThread,
  requestPrompt: string
): void {
  const postFailure = async (message: string): Promise<void> => {
    const ts = nowIso();
    await getDatabase().repositories.chatMessages.save({
      id: randomUUID() as ChatMessageId,
      threadId: thread.id,
      siteId,
      author: { kind: "assistant" },
      body: {
        format: "plain_text",
        value: `I couldn't start this request: ${message}`
      },
      createdAt: ts,
      updatedAt: ts
    });
  };
  // Imported here because request-ingress-service imports this module.
  void import("./request-ingress-service.js")
    .then(({ ingestRequestThreadMessage }) =>
      ingestRequestThreadMessage({
        siteId,
        threadId: thread.id,
        text: requestPrompt,
        gutenbergV2Target: { operation: "create_draft", postType: "post" }
      })
    )
    .then((result) => (result.ok ? undefined : postFailure(result.message)))
    .catch((error: unknown) =>
      postFailure(error instanceof Error ? error.message : String(error))
    );
}

async function buildThreadReply(
  siteId: SiteId,
  threadId: ChatThreadId,
  text: string
): Promise<{ requestId?: RequestId; text: string }> {
  const db = getDatabase();
  const thread = await db.repositories.chatThreads.getById(threadId);
  if (thread?.type === "conversation") {
    const reply = await buildConversationReply({ siteId, threadId, text });
    if (reply.requestPrompt && reply.requestThreadTitle) {
      const requestThreadResult = await createChatThreadForSite(siteId, {
        title: reply.requestThreadTitle,
        type: "general_request"
      });
      if (!requestThreadResult.ok) {
        return {
          text: `${reply.text}\n\nI could not create the new request thread: ${requestThreadResult.message}`
        };
      }
      startResearchDraftRequest(
        siteId,
        requestThreadResult.thread,
        reply.requestPrompt
      );
    }
    return {
      text: reply.text
    };
  }
  const requests = await db.repositories.requests.listByThreadId(threadId);
  const request = requests.at(-1);

  if (!request || request.siteId !== siteId) {
    return {
      text:
        "I recorded that note, but there is no active request in this thread yet. Start a new request from the composer below."
    };
  }

  switch (request.status) {
    case "awaiting_approval":
      return {
        requestId: request.id,
        text:
          "This request is still waiting for approval. Open Approvals to unlock execution."
      };
    case "approved":
      return {
        requestId: request.id,
        text: "This request is approved. Apply it from the request panel."
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
        text: "Note saved on this request."
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
    source: currentCallContext().source,
    createdAt: t,
    updatedAt: t
  };
  await db.repositories.chatThreads.save(thread);
  return { ok: true, thread };
}

export type RenameThreadResult =
  | { ok: true; thread: ChatThread }
  | { ok: false; code: string; message: string };

export async function renameChatThreadForSite(
  siteId: SiteId,
  threadId: ChatThreadId,
  title: string
): Promise<RenameThreadResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }

  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }

  const nextTitle = title.trim();
  if (nextTitle.length === 0) {
    return {
      ok: false,
      code: "thread_title_required",
      message: "Thread title cannot be empty."
    };
  }

  const thread =
    t.thread.title === nextTitle ? t.thread : { ...t.thread, title: nextTitle };
  await getDatabase().repositories.chatThreads.save(thread);
  return { ok: true, thread };
}

export type DeleteThreadResult =
  | { ok: true; threadId: ChatThreadId }
  | { ok: false; code: string; message: string };

export async function deleteChatThreadForSite(
  siteId: SiteId,
  threadId: ChatThreadId
): Promise<DeleteThreadResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }

  const db = getDatabase();
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }

  // Children first, so every foreign key still holds at each step. The old
  // v1 tables are cleared too, for threads made before v1 was removed.
  const threadRequests = `SELECT id FROM requests WHERE thread_id = @threadId`;
  const threadActions = `SELECT actions.id FROM actions
    INNER JOIN requests ON requests.id = actions.request_id
    WHERE requests.thread_id = @threadId`;
  const statements = [
    `DELETE FROM chat_messages WHERE thread_id = @threadId`,
    `DELETE FROM clarification_rounds WHERE request_id IN (${threadRequests})`,
    `DELETE FROM audit_entries WHERE request_id IN (${threadRequests})`,
    `DELETE FROM audit_entries WHERE action_id IN (${threadActions})`,
    `DELETE FROM attachments WHERE request_id IN (${threadRequests})`,
    `DELETE FROM provider_usage_events WHERE request_id IN (${threadRequests})`,
    `DELETE FROM rollback_records WHERE request_id IN (${threadRequests})`,
    `DELETE FROM request_visual_analyses WHERE request_id IN (${threadRequests})`,
    `DELETE FROM gutenberg_v2_request_executions WHERE request_id IN (${threadRequests})`,
    `DELETE FROM approval_decisions WHERE approval_request_id IN (
       SELECT id FROM approval_requests WHERE request_id IN (${threadRequests}))`,
    `DELETE FROM approval_requests WHERE request_id IN (${threadRequests})`,
    `DELETE FROM tool_invocations WHERE execution_run_id IN (
       SELECT id FROM execution_runs WHERE request_id IN (${threadRequests}))`,
    `DELETE FROM execution_runs WHERE request_id IN (${threadRequests})`,
    `DELETE FROM tool_invocations WHERE action_id IN (${threadActions})`,
    `DELETE FROM actions WHERE request_id IN (${threadRequests})`,
    `DELETE FROM action_plans WHERE request_id IN (${threadRequests})`,
    `DELETE FROM requests WHERE thread_id = @threadId`,
    `DELETE FROM chat_threads WHERE id = @threadId`
  ];
  await db.sql.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.prepare(statement).run({ threadId });
    }
  });
  return { ok: true, threadId };
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

export async function appendSystemChatMessage(
  siteId: SiteId,
  threadId: ChatThreadId,
  text: string,
  requestId?: RequestId
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
  const existingMessages =
    await db.repositories.chatMessages.listByThreadId(threadId);
  const latestMessage = existingMessages.at(-1);
  if (
    latestMessage !== undefined &&
    "kind" in latestMessage.author &&
    latestMessage.author.kind === "system" &&
    latestMessage.body.value === text
  ) {
    return { ok: true, message: latestMessage };
  }
  const ts = nowIso();
  const message: ChatMessage = {
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    ...(requestId !== undefined ? { requestId } : {}),
    author: { kind: "system" },
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

export async function postChatMessage(
  siteId: SiteId,
  threadId: ChatThreadId,
  text: string,
  attachments?: ImageAttachmentPayload[]
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
    author: currentActor(),
    body: { format: "plain_text", value: text },
    ...(attachments !== undefined && attachments.length > 0
      ? { attachments }
      : {}),
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
  userPrompt: string,
  attachments?: ImageAttachmentPayload[]
): Promise<CreateRequestResult> {
  const gate = await requireActiveSite(siteId);
  if (!gate.ok) {
    return gate;
  }
  const t = await loadThreadForSite(threadId, siteId);
  if (!t.ok) {
    return t;
  }
  return createRequestRecordForThread({
    siteId,
    thread: t.thread,
    userPrompt,
    ...(attachments !== undefined ? { attachments } : {})
  });
}

export async function answerClarificationForRequest(
  siteId: SiteId,
  threadId: ChatThreadId,
  requestId: RequestId,
  answer: string,
  attachments?: ImageAttachmentPayload[]
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
    author: currentActor(),
    body: { format: "plain_text", value: trimmed },
    ...(attachments !== undefined && attachments.length > 0
      ? { attachments }
      : {}),
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
    actor: currentActor(),
    metadata: { answerLength: trimmed.length },
    createdAt: ts,
    updatedAt: ts
  });

  const mergedPrompt = `${request.userPrompt}\n\nClarification:\n${trimmed}`;
  const mergedRequestAttachments = mergeAttachments(
    request.attachments,
    attachments
  );
  const updatedRequest: Request = {
    ...request,
    status: "new",
    userPrompt: mergedPrompt,
    ...(mergedRequestAttachments !== undefined
      ? { attachments: mergedRequestAttachments }
      : {}),
    updatedAt: ts
  };
  await db.repositories.requests.save(updatedRequest);
  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    requestId,
    author: { kind: "assistant" },
    body: { format: "plain_text", value: "Answer recorded." },
    createdAt: ts,
    updatedAt: ts
  });

  await saveThreadUpdatedAt(t.thread, ts);
  return { ok: true, request: updatedRequest };
}

export async function amendRequestForThread(
  siteId: SiteId,
  threadId: ChatThreadId,
  requestId: RequestId,
  text: string,
  attachments?: ImageAttachmentPayload[]
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
  if (request.status === "executing") {
    return {
      ok: false,
      code: "request_locked",
      message:
        "This request is executing right now. Wait for it to finish before revising the request."
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
    author: currentActor(),
    body: { format: "plain_text", value: trimmed },
    ...(attachments !== undefined && attachments.length > 0
      ? { attachments }
      : {}),
    createdAt: ts,
    updatedAt: ts
  });

  const mergedRequestAttachments = mergeAttachments(
    request.attachments,
    attachments
  );
  const mergedPrompt = await mergeFollowUpIntoRequestPrompt(
    request.userPrompt,
    trimmed
  );

  const updatedRequest: Request = {
    id: request.id,
    siteId: request.siteId,
    threadId: request.threadId,
    requestedBy: request.requestedBy,
    status: "new",
    userPrompt: mergedPrompt,
    ...(mergedRequestAttachments !== undefined
      ? { attachments: mergedRequestAttachments }
      : {}),
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
      value: "Request updated to include that change."
    },
    createdAt: ts,
    updatedAt: ts
  });

  await saveThreadUpdatedAt(t.thread, ts);
  return { ok: true, request: updatedRequest };
}
