import type { ImageAttachmentPayload } from "@sitepilot/contracts";
import type {
  ChatThreadId,
  ClarificationRound,
  Request,
  RequestStatus,
  SiteId
} from "@sitepilot/domain";

import {
  amendRequestForThread,
  answerClarificationForRequest,
  createTypedRequestForThread,
  postChatMessage,
  type CreateRequestResult
} from "./chat-service.js";
import { getDatabase } from "./app-database.js";
import {
  continueGutenbergV2AfterFollowUp,
  hasGutenbergV2RequestMapping,
  type GutenbergV2Target
} from "./gutenberg-v2-chat-service.js";
import { generateActionPlanForRequest } from "./plan-generation-service.js";

export const OPEN_FOLLOW_UP_STATUSES = [
  "new",
  "clarifying",
  "drafted",
  "awaiting_approval",
  "approved"
] as const satisfies readonly RequestStatus[];

const OPEN_FOLLOW_UP_STATUS_SET = new Set<RequestStatus>(
  OPEN_FOLLOW_UP_STATUSES
);

export type IngestThreadOutcome =
  | "created"
  | "amended"
  | "clarified"
  | "noted";

type GutenbergV2ContinueState = Extract<
  Awaited<ReturnType<typeof continueGutenbergV2AfterFollowUp>>,
  { ok: true }
>["state"];
type GeneratedPlan = Extract<
  Awaited<ReturnType<typeof generateActionPlanForRequest>>,
  { ok: true }
>["plan"];
type GeneratedValidation = Extract<
  Awaited<ReturnType<typeof generateActionPlanForRequest>>,
  { ok: true }
>["validation"];

export type IngestThreadMessageResult =
  | {
      ok: true;
      outcome: IngestThreadOutcome;
      request?: Request;
      clarificationRound?: ClarificationRound;
      continued: boolean;
      gutenbergV2State?: GutenbergV2ContinueState;
      plan?: GeneratedPlan;
      validation?: GeneratedValidation;
    }
  | { ok: false; code: string; message: string; request?: Request };

export function selectOpenRequestForFollowUp(
  requests: readonly Request[]
): Request | null {
  const open = requests.filter((request) =>
    OPEN_FOLLOW_UP_STATUS_SET.has(request.status)
  );
  if (open.length === 0) {
    return null;
  }
  return (
    [...open].sort((left, right) => {
      const byCreated = left.createdAt.localeCompare(right.createdAt);
      if (byCreated !== 0) {
        return byCreated;
      }
      return left.updatedAt.localeCompare(right.updatedAt);
    }).at(-1) ?? null
  );
}

function selectExecutingRequest(
  requests: readonly Request[]
): Request | null {
  return (
    [...requests]
      .filter((request) => request.status === "executing")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1) ?? null
  );
}

async function continueOpenRequest(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  request: Request;
  note: string;
  gutenbergV2Target?: GutenbergV2Target;
  alwaysContinue?: boolean;
}): Promise<
  | {
      ok: true;
      continued: boolean;
      gutenbergV2State?: GutenbergV2ContinueState;
      plan?: GeneratedPlan;
      validation?: GeneratedValidation;
    }
  | { ok: false; code: string; message: string }
> {
  if (input.request.status !== "new") {
    return { ok: true, continued: false };
  }

  const v2Bound =
    hasGutenbergV2RequestMapping(input.siteId, input.request.id) ||
    input.gutenbergV2Target !== undefined;
  if (v2Bound) {
    const generated = await continueGutenbergV2AfterFollowUp({
      siteId: input.siteId,
      requestId: input.request.id,
      note: input.note,
      ...(input.gutenbergV2Target !== undefined
        ? { target: input.gutenbergV2Target }
        : {})
    });
    if (!generated.ok) {
      return generated;
    }
    return {
      ok: true,
      continued: true,
      gutenbergV2State: generated.state
    };
  }

  if (input.alwaysContinue === true || input.request.latestPlanId !== undefined) {
    const planned = await generateActionPlanForRequest(
      input.siteId,
      input.threadId,
      input.request.id
    );
    if (!planned.ok) {
      return planned;
    }
    return {
      ok: true,
      continued: true,
      plan: planned.plan,
      validation: planned.validation
    };
  }

  return { ok: true, continued: false };
}

function fromCreateResult(
  result: CreateRequestResult,
  outcome: Extract<IngestThreadOutcome, "created" | "amended" | "clarified">
): Extract<IngestThreadMessageResult, { ok: true }> | Extract<
  IngestThreadMessageResult,
  { ok: false }
> {
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    outcome,
    request: result.request,
    ...(result.clarificationRound !== undefined
      ? { clarificationRound: result.clarificationRound }
      : {}),
    continued: false
  };
}

function withContinue(
  ingested: Extract<IngestThreadMessageResult, { ok: true }>,
  continued: Awaited<ReturnType<typeof continueOpenRequest>>
): IngestThreadMessageResult {
  if (!ingested.request) {
    return ingested;
  }
  if (!continued.ok) {
    return {
      ok: false,
      code: continued.code,
      message: continued.message,
      request: ingested.request
    };
  }
  return {
    ...ingested,
    continued: continued.continued,
    ...(continued.gutenbergV2State !== undefined
      ? { gutenbergV2State: continued.gutenbergV2State }
      : {}),
    ...(continued.plan !== undefined ? { plan: continued.plan } : {}),
    ...(continued.validation !== undefined
      ? { validation: continued.validation }
      : {})
  };
}

export async function ingestRequestThreadMessage(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  text: string;
  attachments?: ImageAttachmentPayload[];
  gutenbergV2Target?: GutenbergV2Target;
  alwaysContinue?: boolean;
}): Promise<IngestThreadMessageResult> {
  const trimmed = input.text.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "request_empty",
      message: "Message cannot be empty."
    };
  }

  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
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
  const thread = await db.repositories.chatThreads.getById(input.threadId);
  if (!thread) {
    return {
      ok: false,
      code: "thread_not_found",
      message: "Thread not found."
    };
  }
  if (thread.siteId !== input.siteId) {
    return {
      ok: false,
      code: "thread_site_mismatch",
      message: "Thread does not belong to this site."
    };
  }

  const attachments =
    input.attachments !== undefined && input.attachments.length > 0
      ? input.attachments
      : undefined;

  if (thread.type === "conversation") {
    const posted = await postChatMessage(
      input.siteId,
      input.threadId,
      trimmed,
      attachments
    );
    if (!posted.ok) {
      return posted;
    }
    return { ok: true, outcome: "noted", continued: false };
  }

  const requests = await db.repositories.requests.listByThreadId(input.threadId);
  const openRequest = selectOpenRequestForFollowUp(requests);
  if (openRequest !== null) {
    if (openRequest.status === "clarifying") {
      const answered = fromCreateResult(
        await answerClarificationForRequest(
          input.siteId,
          input.threadId,
          openRequest.id,
          trimmed,
          attachments
        ),
        "clarified"
      );
      if (!answered.ok || answered.request === undefined) {
        return answered;
      }
      return withContinue(
        answered,
        await continueOpenRequest({
          siteId: input.siteId,
          threadId: input.threadId,
          request: answered.request,
          note: trimmed,
          ...(input.gutenbergV2Target !== undefined
            ? { gutenbergV2Target: input.gutenbergV2Target }
            : {}),
          ...(input.alwaysContinue !== undefined
            ? { alwaysContinue: input.alwaysContinue }
            : {})
        })
      );
    }

    const amended = fromCreateResult(
      await amendRequestForThread(
        input.siteId,
        input.threadId,
        openRequest.id,
        trimmed,
        attachments
      ),
      "amended"
    );
    if (!amended.ok || amended.request === undefined) {
      return amended;
    }
    return withContinue(
      amended,
      await continueOpenRequest({
        siteId: input.siteId,
        threadId: input.threadId,
        request: amended.request,
        note: trimmed,
        ...(input.gutenbergV2Target !== undefined
          ? { gutenbergV2Target: input.gutenbergV2Target }
          : {}),
        ...(input.alwaysContinue !== undefined
          ? { alwaysContinue: input.alwaysContinue }
          : {})
      })
    );
  }

  const executing = selectExecutingRequest(requests);
  if (executing !== null) {
    const posted = await postChatMessage(
      input.siteId,
      input.threadId,
      trimmed,
      attachments
    );
    if (!posted.ok) {
      return posted;
    }
    return {
      ok: true,
      outcome: "noted",
      request: executing,
      continued: false
    };
  }

  const created = fromCreateResult(
    await createTypedRequestForThread(
      input.siteId,
      input.threadId,
      trimmed,
      attachments,
      input.gutenbergV2Target !== undefined ? "gutenberg_v2" : undefined
    ),
    "created"
  );
  if (!created.ok || created.request === undefined) {
    return created;
  }
  return withContinue(
    created,
    await continueOpenRequest({
      siteId: input.siteId,
      threadId: input.threadId,
      request: created.request,
      note: trimmed,
      ...(input.gutenbergV2Target !== undefined
        ? { gutenbergV2Target: input.gutenbergV2Target }
        : {}),
      ...(input.alwaysContinue !== undefined
        ? { alwaysContinue: input.alwaysContinue }
        : {})
    })
  );
}
