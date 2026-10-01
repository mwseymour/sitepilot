import { randomUUID } from "node:crypto";

import { classifyErrorCode } from "@sitepilot/contracts";

import type {
  AuditEntryId,
  ChatMessage,
  ChatThreadId,
  ClientSource,
  Request,
  RequestId,
  SiteId,
  SiteRole
} from "@sitepilot/domain";
import { isMcpToolError, normalizeMcpToolResult } from "@sitepilot/mcp-client";
import {
  clientSourceFromName,
  type McpCaller,
  type McpRequestState,
  type McpRequestStatus,
  type McpRequestTarget,
  type McpResult,
  type McpSite,
  type McpThreadMessage,
  type McpThreadSummary,
  type SitePilotMcpBackend
} from "@sitepilot/mcp-server";

import { getDatabase } from "./app-database.js";
import {
  DEFAULT_OPERATOR,
  assertCallerMay,
  currentActor,
  runWithCallContext,
  type CallContext
} from "./call-context.js";
import {
  createChatThreadForSite,
  listChatMessagesForThread,
  postChatMessage
} from "./chat-service.js";
import {
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  getGutenbergV2RequestState,
  getGutenbergV2ReviewArtifact,
  type GutenbergV2Target
} from "./gutenberg-v2-chat-service.js";
import { wordpressEditUrl } from "./gutenberg-v2-report.js";
import { ingestRequestThreadMessage } from "./request-ingress-service.js";
import { getSiteActivitySummary } from "./site-activity-service.js";
import { createMcpClientForSite } from "./site-mcp-client.js";

/** Local MCP clients act for the desktop's own operator. */
const LOCAL_MCP_SITE_ROLES: SiteRole[] = ["request"];

const MAX_RECENT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 2_000;

type V2State = NonNullable<
  Extract<
    Awaited<ReturnType<typeof getGutenbergV2RequestState>>,
    { ok: true }
  >["state"]
>;

type BackgroundJob =
  | { status: "running"; startedAt: string }
  | {
      status: "failed";
      code: string;
      message: string;
      retryable?: boolean;
      at: string;
    };

export type DesktopMcpBackendOptions = {
  /** The sites this client may use, or "all" for every active site. */
  siteScope: "all" | readonly string[];
  /** Where people approve; the hosted server names its own address. */
  approvalHint?: string;
  /** Links to review artifacts that open without signing in (hosted). */
  links?: {
    artifact(siteId: string, requestId: string, artifactId: string): string;
  };
  /**
   * Lets a person approve from a chat app, by answering the app's prompt or
   * the review card (hosted). The model can't approve; see approvalSubject.
   */
  chatApproval?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function fail(code: string, message: string) {
  return { ok: false as const, code, message };
}

function failureOf(
  code: string,
  message: string,
  retryable?: boolean
): NonNullable<McpRequestStatus["failure"]> {
  const classified = classifyErrorCode(code);
  return {
    code,
    cause: classified.cause,
    retryable: retryable ?? classified.retryable,
    message
  };
}

function callContextFor(caller: McpCaller, tool: string): CallContext {
  return {
    actor: caller.actor
      ? (caller.actor as CallContext["actor"])
      : { ...DEFAULT_OPERATOR, siteRoles: LOCAL_MCP_SITE_ROLES },
    source: clientSourceFromName(caller.clientName),
    tool
  };
}

function toV2Target(target: McpRequestTarget): GutenbergV2Target {
  switch (target.operation) {
    case "create_draft":
      return { operation: "create_draft", postType: target.postType };
    case "edit":
      return {
        operation: "apply_operations",
        postType: target.postType,
        postId: target.postId
      };
    case "replace":
      return {
        operation: "replace_content",
        postType: target.postType,
        postId: target.postId
      };
    case "publish":
    case "unpublish":
      return {
        operation: "set_status",
        postType: target.postType,
        postId: target.postId,
        status: target.operation === "publish" ? "publish" : "draft"
      };
  }
}

function fromV2Target(target: GutenbergV2Target): McpRequestTarget {
  switch (target.operation) {
    case "create_draft":
      return { operation: "create_draft", postType: target.postType };
    case "apply_operations":
      return {
        operation: "edit",
        postType: target.postType,
        postId: target.postId
      };
    case "replace_content":
      return {
        operation: "replace",
        postType: target.postType,
        postId: target.postId
      };
    case "set_status":
      return {
        operation: target.status === "publish" ? "publish" : "unpublish",
        postType: target.postType,
        postId: target.postId
      };
  }
}

function threadTitle(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || "Request";
}

function messageFrom(message: ChatMessage): McpThreadMessage["from"] {
  return "kind" in message.author ? "sitepilot" : "you";
}

function recentMessages(messages: readonly ChatMessage[]): McpThreadMessage[] {
  return messages.slice(-MAX_RECENT_MESSAGES).map((message) => ({
    from: messageFrom(message),
    text:
      message.body.value.length > MAX_MESSAGE_CHARS
        ? `${message.body.value.slice(0, MAX_MESSAGE_CHARS)}…`
        : message.body.value,
    at: message.createdAt
  }));
}

function lastSitePilotMessage(
  messages: readonly ChatMessage[]
): ChatMessage | undefined {
  return [...messages].reverse().find((m) => messageFrom(m) === "sitepilot");
}

function stateFromV2(state: V2State["state"]): McpRequestState {
  switch (state) {
    case "planned":
    case "compiling":
      return "preparing_preview";
    case "review_ready":
      return "awaiting_approval";
    case "approved":
      return "approved";
    case "preparing":
    case "committing":
    case "verifying":
      return "applying";
    case "succeeded":
      return "completed";
    case "rejected":
      return "rejected";
    default:
      return "needs_attention";
  }
}

function stateFromRequest(status: Request["status"]): McpRequestState {
  switch (status) {
    case "new":
    case "drafted":
      return "preparing_preview";
    case "clarifying":
      return "needs_your_reply";
    case "awaiting_approval":
      return "awaiting_approval";
    case "approved":
      return "approved";
    case "executing":
      return "applying";
    case "completed":
      return "completed";
    case "archived":
      return "rejected";
    default:
      return "needs_attention";
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const STATE_SUMMARIES: Record<McpRequestState, string> = {
  preparing_preview:
    "SitePilot is planning the change and building a preview. Check again shortly.",
  needs_your_reply:
    "SitePilot needs an answer before it can continue. Reply with add_to_request.",
  awaiting_approval:
    "The preview is ready and waiting for a person to approve it in SitePilot. Use add_to_request to ask for changes first.",
  approved: "The change is approved and waiting to be applied in SitePilot.",
  applying: "SitePilot is writing the change to the site and verifying it.",
  completed: "The change was written to the site and verified.",
  rejected: "The change was rejected in SitePilot. Nothing was written.",
  needs_attention:
    "The request needs attention. See the latest SitePilot message."
};

const APPROVAL_HINT =
  "Open the SitePilot desktop app, choose this site and open the thread to review and approve. MCP clients cannot approve.";

/**
 * The SitePilot MCP tools over the desktop's local services. Each call runs in
 * a call context that records the client as the source.
 */
export function createDesktopMcpBackend(
  options: DesktopMcpBackendOptions
): SitePilotMcpBackend & { idle(): Promise<void> } {
  const jobs = new Map<string, BackgroundJob>();
  const running = new Set<Promise<unknown>>();

  function inScope(siteId: string): boolean {
    return options.siteScope === "all" || options.siteScope.includes(siteId);
  }

  function scoped<T>(
    tool: string,
    caller: McpCaller,
    fn: () => Promise<McpResult<T>>
  ): Promise<McpResult<T>> {
    return runWithCallContext(callContextFor(caller, tool), fn);
  }

  /** The newest request in a request thread. */
  async function latestRequest(siteId: string, threadId: string) {
    const loaded = await loadRequestThread(siteId, threadId);
    if (!loaded.ok) return loaded;
    const requests = [
      ...(await getDatabase().repositories.requests.listByThreadId(loaded.thread.id))
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const request = requests.at(-1);
    return request
      ? { ok: true as const, request }
      : fail("request_not_found", "This thread has no request yet.");
  }

  async function loadRequestThread(siteId: string, threadId: string) {
    if (!inScope(siteId)) return fail("site_not_found", "Site not available.");
    const thread = await getDatabase().repositories.chatThreads.getById(
      threadId as ChatThreadId
    );
    if (!thread || thread.siteId !== siteId || thread.archivedAt) {
      return fail(
        "request_not_found",
        "No request with that ID on this site. Use list_threads."
      );
    }
    if (thread.type === "conversation") {
      return fail(
        "not_a_request",
        "That thread is a Conversation. Use ask to continue it."
      );
    }
    return { ok: true as const, thread };
  }

  async function buildStatus(
    siteId: string,
    threadId: string
  ): Promise<McpResult<{ status: McpRequestStatus }>> {
    const loaded = await loadRequestThread(siteId, threadId);
    if (!loaded.ok) return loaded;
    const { thread } = loaded;
    const db = getDatabase();
    const messages = await db.repositories.chatMessages.listByThreadId(
      thread.id
    );
    const requests = [
      ...(await db.repositories.requests.listByThreadId(thread.id))
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const request = requests.at(-1);
    const job = jobs.get(threadId);

    let v2: V2State | null = null;
    if (request) {
      const read = await getGutenbergV2RequestState({
        siteId: siteId as SiteId,
        requestId: request.id
      });
      if (read.ok) v2 = read.state;
    }

    let state: McpRequestState;
    let summary: string;
    let failure: McpRequestStatus["failure"];
    if (job?.status === "running") {
      state = "preparing_preview";
      summary = STATE_SUMMARIES.preparing_preview;
    } else if (
      job?.status === "failed" &&
      (v2 === null || v2.updatedAt <= job.at)
    ) {
      state = "needs_attention";
      summary = job.message;
      failure = failureOf(job.code, job.message, job.retryable);
    } else if (request?.status === "clarifying") {
      state = "needs_your_reply";
      summary = STATE_SUMMARIES.needs_your_reply;
    } else if (v2 !== null) {
      state = stateFromV2(v2.state);
      summary = STATE_SUMMARIES[state];
    } else if (request) {
      state = stateFromRequest(request.status);
      summary = STATE_SUMMARIES[state];
    } else {
      state = "needs_attention";
      summary = "This thread has no request yet. Send one with add_to_request.";
    }

    const latestReply = lastSitePilotMessage(messages);
    const site = await db.repositories.sites.getById(siteId as SiteId);
    const candidate = v2?.candidate;
    const postId = v2?.result?.postId;
    const status: McpRequestStatus = {
      requestId: thread.id,
      siteId,
      title: thread.title,
      state,
      summary,
      ...(state === "needs_your_reply" && latestReply
        ? { question: latestReply.body.value }
        : {}),
      ...(v2 ? { target: fromV2Target(v2.target) } : {}),
      ...(candidate
        ? {
            changes: {
              operation: candidate.operation,
              ...(text(candidate.requestedPostFields.title) !== undefined
                ? { title: text(candidate.requestedPostFields.title) as string }
                : {}),
              ...(text(candidate.requestedPostFields.excerpt) !== undefined
                ? {
                    excerpt: text(
                      candidate.requestedPostFields.excerpt
                    ) as string
                  }
                : {}),
              ...(candidate.seoChanges
                ? {
                    seo: candidate.seoChanges.map((change) => ({
                      label: change.label,
                      value: change.value
                    }))
                  }
                : {}),
              ...(candidate.featuredImage
                ? { featuredImage: candidate.featuredImage.label }
                : {})
            },
            reviewArtifacts: candidate.reviewArtifacts.map((artifact) => ({
              id: artifact.id,
              kind: artifact.kind,
              ...(options.links
                ? { url: options.links.artifact(siteId, threadId, artifact.id) }
                : {})
            }))
          }
        : {}),
      ...(postId !== undefined
        ? {
            result: {
              postId,
              ...(site
                ? { editUrl: wordpressEditUrl(site.baseUrl, postId) }
                : {})
            }
          }
        : {}),
      ...(state === "awaiting_approval" || state === "approved"
        ? { approvalHint: options.approvalHint ?? APPROVAL_HINT }
        : {}),

      ...(failure === undefined && v2?.failure && state !== "completed"
        ? {
            failure: failureOf(v2.failure.code, v2.failure.message)
          }
        : failure !== undefined
          ? { failure }
          : {}),
      recentMessages: recentMessages(messages),
      updatedAt: [thread.updatedAt, request?.updatedAt, v2?.updatedAt]
        .filter((value): value is string => value !== undefined)
        .sort()
        .at(-1) as string
    };
    return { ok: true, status };
  }

  /** Run a request message in the background; the tool returns at once. */
  function startIngest(
    context: CallContext,
    input: {
      siteId: string;
      threadId: string;
      text: string;
      target: GutenbergV2Target;
    }
  ): void {
    jobs.set(input.threadId, { status: "running", startedAt: nowIso() });
    const work = runWithCallContext(context, () =>
      ingestRequestThreadMessage({
        siteId: input.siteId as SiteId,
        threadId: input.threadId as ChatThreadId,
        text: input.text,
        gutenbergV2Target: input.target
      })
    )
      .then((result) => {
        if (result.ok) {
          jobs.delete(input.threadId);
        } else {
          jobs.set(input.threadId, {
            status: "failed",
            code: result.code,
            message: result.message,
            ...("retryable" in result && typeof result.retryable === "boolean"
              ? { retryable: result.retryable }
              : {}),
            at: nowIso()
          });
        }
      })
      .catch((error: unknown) => {
        jobs.set(input.threadId, {
          status: "failed",
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
          at: nowIso()
        });
      })
      .finally(() => running.delete(work));
    running.add(work);
  }

  async function answerFromThread(
    siteId: string,
    threadId: ChatThreadId
  ): Promise<string> {
    const listed = await listChatMessagesForThread(siteId as SiteId, threadId);
    if (!listed.ok) return "";
    return lastSitePilotMessage(listed.messages)?.body.value ?? "";
  }

  return {
    async idle() {
      while (running.size > 0) {
        await Promise.allSettled([...running]);
      }
    },

    async listSites(): Promise<McpSite[]> {
      const rows = await getDatabase()
        .sql.prepare<[], { id: string; name: string; baseUrl: string }>(
          `SELECT id, name, base_url AS "baseUrl" FROM sites
            WHERE activation_status = 'active' ORDER BY name`
        )
        .all();
      return rows
        .filter((row) => inScope(row.id))
        .map((row) => ({
          siteId: row.id,
          name: row.name,
          baseUrl: row.baseUrl
        }));
    },

    lookup({ siteId, tool, args }, caller) {
      return scoped(tool.name, caller, async () => {
        const allowed = assertCallerMay("read");
        if (!allowed.ok) return allowed;
        if (!inScope(siteId))
          return fail("site_not_found", "Site not available.");
        if (tool.source.kind === "discovery") {
          const snapshot =
            await getDatabase().repositories.discoverySnapshots.getLatest(
              siteId as SiteId
            );
          if (!snapshot) {
            return fail(
              "discovery_missing",
              "SitePilot has not discovered this site yet. Refresh discovery in the desktop app."
            );
          }
          return {
            ok: true,
            result: {
              discoveredAt: snapshot.createdAt,
              capabilities: snapshot.capabilities,
              warnings: snapshot.warnings,
              summary: snapshot.summary
            }
          };
        }
        const mcp = await createMcpClientForSite(siteId as SiteId);
        if (!mcp.ok) return fail(mcp.code, mcp.message);
        const raw = await mcp.client.callTool(tool.source.ability, args);
        const result = normalizeMcpToolResult(raw);
        // Some abilities report a failure in-band with ok: false.
        if (isMcpToolError(raw) || result.ok === false) {
          return fail(
            "lookup_failed",
            typeof result.error === "string"
              ? result.error
              : typeof result.raw === "string"
                ? result.raw
                : "The lookup failed."
          );
        }
        return { ok: true, result };
      });
    },

    createConversation({ siteId, question, title }, caller) {
      return scoped("create_conversation", caller, async () => {
        const allowed = assertCallerMay("read");
        if (!allowed.ok) return allowed;
        if (!inScope(siteId))
          return fail("site_not_found", "Site not available.");
        const created = await createChatThreadForSite(siteId as SiteId, {
          title: title ?? threadTitle(question),
          type: "conversation"
        });
        if (!created.ok) return created;
        const posted = await postChatMessage(
          siteId as SiteId,
          created.thread.id,
          question
        );
        if (!posted.ok) return posted;
        return {
          ok: true,
          threadId: created.thread.id,
          answer: await answerFromThread(siteId, created.thread.id)
        };
      });
    },

    ask({ siteId, threadId, question }, caller) {
      return scoped("ask", caller, async () => {
        const allowed = assertCallerMay("read");
        if (!allowed.ok) return allowed;
        if (!inScope(siteId))
          return fail("site_not_found", "Site not available.");
        const thread = await getDatabase().repositories.chatThreads.getById(
          threadId as ChatThreadId
        );
        if (!thread || thread.siteId !== siteId || thread.archivedAt) {
          return fail(
            "thread_not_found",
            "No conversation with that ID on this site."
          );
        }
        if (thread.type !== "conversation") {
          return fail(
            "not_a_conversation",
            "That thread is a Request. Use add_to_request to continue it."
          );
        }
        const posted = await postChatMessage(
          siteId as SiteId,
          thread.id,
          question
        );
        if (!posted.ok) return posted;
        return {
          ok: true,
          threadId: thread.id,
          answer: await answerFromThread(siteId, thread.id)
        };
      });
    },

    createRequest({ siteId, text, target, title }, caller) {
      const context = callContextFor(caller, "create_request");
      return runWithCallContext(context, async () => {
        const allowed = assertCallerMay("request");
        if (!allowed.ok) return allowed;
        if (!inScope(siteId))
          return fail("site_not_found", "Site not available.");
        const created = await createChatThreadForSite(siteId as SiteId, {
          title: title ?? threadTitle(text),
          type: "general_request"
        });
        if (!created.ok) return created;
        startIngest(context, {
          siteId,
          threadId: created.thread.id,
          text,
          target: toV2Target(target)
        });
        return buildStatus(siteId, created.thread.id);
      });
    },

    addToRequest({ siteId, requestId, text }, caller) {
      const context = callContextFor(caller, "add_to_request");
      return runWithCallContext(context, async () => {
        const allowed = assertCallerMay("request");
        if (!allowed.ok) return allowed;
        const loaded = await loadRequestThread(siteId, requestId);
        if (!loaded.ok) return loaded;
        if (jobs.get(requestId)?.status === "running") {
          return fail(
            "request_busy",
            "SitePilot is still preparing this request. Wait for request_status to change, then send the follow-up."
          );
        }
        // Same default as the desktop composer: a thread that already wrote
        // a post updates that post, and an open request keeps its target.
        const latest = [
          ...(await getDatabase().repositories.requests.listByThreadId(
            loaded.thread.id
          ))
        ]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .at(-1);
        let postType: "post" | "page" = "post";
        if (latest) {
          const read = await getGutenbergV2RequestState({
            siteId: siteId as SiteId,
            requestId: latest.id as RequestId
          });
          if (read.ok && read.state) postType = read.state.target.postType;
        }
        startIngest(context, {
          siteId,
          threadId: requestId,
          text,
          target: { operation: "create_draft", postType }
        });
        return buildStatus(siteId, requestId);
      });
    },

    requestStatus({ siteId, requestId }, caller) {
      return scoped("request_status", caller, async () => {
        const allowed = assertCallerMay("read");
        if (!allowed.ok) return allowed;
        return buildStatus(siteId, requestId);
      });
    },

    listThreads({ siteId, kind, source, limit }, caller) {
      return scoped("list_threads", caller, async () => {
        const allowed = assertCallerMay("read");
        if (!allowed.ok) return allowed;
        if (!inScope(siteId))
          return fail("site_not_found", "Site not available.");
        const activity = await getSiteActivitySummary({
          siteId: siteId as SiteId,
          limit: 200
        });
        if (!activity.ok) return activity;
        const threads: McpThreadSummary[] = activity.threads
          .map((thread): McpThreadSummary => {
            const threadKind =
              thread.type === "conversation" ? "conversation" : "request";
            const running = jobs.get(thread.threadId)?.status === "running";
            return {
              threadId: thread.threadId,
              kind: threadKind,
              title: thread.title,
              source: thread.source ?? "desktop",
              ...(threadKind === "request"
                ? {
                    state: running
                      ? "preparing_preview"
                      : thread.v2State
                        ? stateFromV2(thread.v2State)
                        : thread.requestStatus
                          ? stateFromRequest(thread.requestStatus)
                          : "needs_attention"
                  }
                : {}),
              updatedAt: thread.updatedAt
            };
          })
          .filter((thread) => kind === undefined || thread.kind === kind)
          .filter((thread) => source === undefined || thread.source === source)
          .slice(0, limit);
        return { ok: true, threads };
      });
    },

    ...(options.chatApproval
      ? {
          approvalSubject: ({ siteId, requestId }: { siteId: string; requestId: string }, caller: McpCaller) =>
            scoped("approval_subject", caller, async () => {
              const latest = await latestRequest(siteId, requestId);
              if (!latest.ok) return latest;
              const state = await getGutenbergV2RequestState({
                siteId: siteId as SiteId,
                requestId: latest.request.id
              });
              const candidateId = state.ok ? state.state?.candidate?.candidateId : undefined;
              const built = await buildStatus(siteId, requestId);
              if (!built.ok) return built;
              if (!candidateId || built.status.state !== "awaiting_approval") {
                return fail(
                  "not_awaiting_approval",
                  "There's no preview waiting for approval on this request. Check request_status."
                );
              }
              return { ok: true as const, candidateId, status: built.status };
            }),
          decideForPerson: (
            input: {
              siteId: string;
              requestId: string;
              candidateId: string;
              decision: "approve" | "reject";
              note?: string;
              channel: string;
            },
            caller: McpCaller
          ) =>
            scoped(input.channel, caller, async () => {
              const allowed = assertCallerMay("approve");
              if (!allowed.ok) return allowed;
              const latest = await latestRequest(input.siteId, input.requestId);
              if (!latest.ok) return latest;
              const requestId = latest.request.id as RequestId;
              // The candidate the person saw: a newer preview needs a new answer.
              const decided = await decideGutenbergV2Candidate({
                siteId: input.siteId as SiteId,
                requestId,
                candidateId: input.candidateId,
                decision: input.decision === "approve" ? "approved" : "rejected",
                ...(input.note ? { note: input.note } : {}),
                ...(input.decision === "approve" ? { applyingNow: true } : {})
              });
              if (!("state" in decided)) return fail(decided.code, decided.message);
              if (input.decision === "approve") {
                // Applying takes a minute; request_status shows its progress.
                const work = executeGutenbergV2Candidate({ siteId: input.siteId as SiteId, requestId })
                  .catch((error: unknown) => console.log(`Applying ${requestId} failed: ${String(error)}`))
                  .finally(() => running.delete(work));
                running.add(work);
              }
              return buildStatus(input.siteId, input.requestId);
            })
        }
      : {}),

    getReviewArtifact({ siteId, requestId, artifactId }, caller) {
      return scoped("get_review_artifact", caller, async () => {
        const allowed = assertCallerMay("read");
        if (!allowed.ok) return allowed;
        const loaded = await loadRequestThread(siteId, requestId);
        if (!loaded.ok) return loaded;
        const requests = [
          ...(await getDatabase().repositories.requests.listByThreadId(
            loaded.thread.id
          ))
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const request = requests.at(-1);
        if (!request) return fail("artifact_not_found", "No review yet.");
        const read = await getGutenbergV2ReviewArtifact({
          siteId: siteId as SiteId,
          requestId: request.id,
          artifactId
        });
        if (!read.ok) return fail(read.code, read.message);
        return {
          ok: true,
          artifact: {
            ...read.artifact,
            ...(options.links
              ? { url: options.links.artifact(siteId, requestId, artifactId) }
              : {})
          }
        };
      });
    },

    async recordToolCall({ tool, siteId, ok, code }, caller) {
      if (siteId === undefined || !inScope(siteId)) return;
      await runWithCallContext(callContextFor(caller, tool), async () => {
        const site = await getDatabase().repositories.sites.getById(
          siteId as SiteId
        );
        if (!site) return;
        const ts = nowIso();
        await getDatabase().repositories.auditEntries.append({
          id: randomUUID() as AuditEntryId,
          siteId: siteId as SiteId,
          eventType: "mcp_tool_called",
          actor: currentActor(),
          metadata: {
            tool,
            client: caller.clientName ?? null,
            source: clientSourceFromName(caller.clientName) as ClientSource,
            ok,
            ...(code !== undefined ? { code } : {})
          },
          createdAt: ts,
          updatedAt: ts
        });
      });
    }
  };
}
