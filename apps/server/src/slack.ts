import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getDatabase } from "@sitepilot/core/app-database";
import { isTypedApproval } from "@sitepilot/core/request-ingress-service";
import type {
  McpAttachment,
  McpCaller,
  McpRequestStatus,
  McpRequestTarget,
  SitePilotMcpBackend
} from "@sitepilot/mcp-server";
import { findReadTool, sanitizeReadToolArguments } from "@sitepilot/services/read-tool-registry";
import type { SqlConnection } from "@sitepilot/sql";

import type { AuthStore, PersonRef, SignedInUser } from "./auth.js";
import { escapeHtml as e, readBody, send, sendHtml } from "./http.js";
import {
  asksForLatest,
  mentionedLinks,
  mentionedPostId,
  onlyPostIdIn,
  routeChoice,
  routeSlackMessage,
  wantsNewPost
} from "./slack-routing.js";

/**
 * SitePilot in Slack: mention @SitePilot (or DM it) to ask about the site or
 * to make a request. A question gets its answer in the thread (a read-only
 * Conversation); a request's thread gets its previews, Approve and Reject
 * buttons, questions and the result. When the wording doesn't say which, the
 * thread asks. Starting with "ask" or "change:" forces one. People connect their Slack account once, by signing in with
 * WordPress, and act with their WordPress role.
 *
 * Approval is a click on Approve, which Slack signs with who clicked. Typing
 * never approves. Slack calls /slack/events and /slack/interactions; requests
 * older than five minutes or without a valid signature are refused.
 */

export type SlackConfig = {
  botToken: string;
  signingSecret: string;
  /** Slack's Web API, overridable for tests. */
  apiBaseUrl?: string;
};

const CONNECT_TTL_SECONDS = 15 * 60;
const SWEEP_INTERVAL_MS = 8_000;

/** Slack's request signing: v0=HMAC-SHA256(secret, "v0:{timestamp}:{body}"). */
export function verifySlackSignature(input: {
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  nowSeconds: number;
}): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(input.nowSeconds - timestamp) > 5 * 60) return false;
  const expected = Buffer.from(
    `v0=${createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:${input.body}`).digest("hex")}`
  );
  const given = Buffer.from(input.signature ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Text for Slack's mrkdwn, with its control characters escaped. */
function md(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type SlackBlock = Record<string, unknown>;

/** choosing: "a question or a change?"; choosing_post: "which post is this for?". */
type ThreadKind = "request" | "conversation" | "choosing" | "choosing_post";

type ThreadRow = {
  teamId: string;
  channelId: string;
  threadTs: string;
  siteId: string;
  /** The SitePilot request, or the Conversation's thread ID; empty while choosing. */
  requestId: string;
  wordpressUserId: number;
  /** For a request, the last update posted; for a conversation, its latest answer. */
  lastNotice: string | null;
  kind: ThreadKind;
  /** While choosing: the message waiting for an answer. */
  pendingText: string | null;
};

/** The post a change is for, worked out from the message. */
type PostTarget =
  | { kind: "existing"; target: McpRequestTarget & { postId: number }; label: string }
  | { kind: "new" }
  | { kind: "unknown"; problem?: string };

const THREAD_COLUMNS = `team_id AS "teamId", channel_id AS "channelId", thread_ts AS "threadTs", site_id AS "siteId",
  request_id AS "requestId", wordpress_user_id AS "wordpressUserId", last_notice AS "lastNotice",
  kind, pending_text AS "pendingText"`;

/** Slack's section blocks take up to 3,000 characters. */
const MAX_SECTION = 2_900;

const OPERATION_LABELS: Record<string, string> = {
  create_draft: "New draft",
  apply_operations: "Edit",
  replace_content: "Replace the content",
  set_status: "Change the post's status (only its status changes)"
};

export function createSlackApp(deps: {
  sql: SqlConnection;
  auth: AuthStore;
  backend: SitePilotMcpBackend;
  publicUrl: URL;
  secretsKey: Buffer;
  /** Unset until the Slack app's token and signing secret are in the environment. */
  config: SlackConfig | null;
}) {
  const connectKey = createHmac("sha256", deps.secretsKey).update("sitepilot slack connect v1").digest();
  const apiBase = deps.config?.apiBaseUrl ?? "https://slack.com/api/";
  let botUserId: string | undefined;
  let sweeping = false;

  async function slack(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!deps.config) throw new Error("Slack isn't configured.");
    const response = await fetch(new URL(method, apiBase), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${deps.config.botToken}` },
      body: JSON.stringify(body)
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (result.ok !== true) throw new Error(`Slack ${method} failed: ${String(result.error ?? response.status)}`);
    return result;
  }

  /** Slack's read methods take form-encoded arguments, not JSON. */
  async function slackRead(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    if (!deps.config) throw new Error("Slack isn't configured.");
    const response = await fetch(new URL(method, apiBase), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${deps.config.botToken}` },
      body: new URLSearchParams(params).toString()
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (result.ok !== true) throw new Error(`Slack ${method} failed: ${String(result.error ?? response.status)}`);
    return result;
  }

  type SlackFile = { name?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string };

  /**
   * Images and videos on the message, to use in the request. Slack serves
   * them only with the bot's token (files:read), and only from its file host.
   */
  async function attachmentsOf(event: { files?: SlackFile[]; channel?: string; ts?: string }): Promise<{
    attachments: McpAttachment[];
    skipped: string[];
  }> {
    let files = event.files;
    if (!files && event.channel && event.ts) {
      // A mention doesn't always carry its files: read the message itself.
      const read = await slackRead("conversations.replies", { channel: event.channel, ts: event.ts, limit: "50" }).catch(() => null);
      const messages = (read?.messages ?? []) as Array<{ ts?: string; files?: SlackFile[] }>;
      files = messages.find((message) => message.ts === event.ts)?.files;
    }
    const allowedOrigins = new Set(["https://files.slack.com", new URL(apiBase).origin]);
    const attachments: McpAttachment[] = [];
    const skipped: string[] = [];
    for (const file of (files ?? []).slice(0, 6)) {
      const name = file.name ?? "file";
      const type = file.mimetype ?? "";
      const url = file.url_private_download ?? file.url_private ?? "";
      if (!/^(?:image\/|video\/(?:mp4|webm)$)/.test(type) || (file.size ?? 0) > 10_000_000) {
        skipped.push(`${name} (only images and MP4 or WebM videos up to 10 MB)`);
        continue;
      }
      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch {
        // Not a URL: skipped below.
      }
      if (!allowedOrigins.has(origin) || !deps.config) {
        skipped.push(name);
        continue;
      }
      const response = await fetch(url, { headers: { authorization: `Bearer ${deps.config.botToken}` } }).catch(() => null);
      const served = response?.headers.get("content-type") ?? "";
      if (!response?.ok || !served.startsWith(type.split("/")[0] ?? "")) {
        skipped.push(`${name} (Slack didn't hand it over: does the app have the files:read scope?)`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      attachments.push({
        fileName: name,
        mediaType: type,
        sizeBytes: bytes.length,
        dataUrl: `data:${type};base64,${bytes.toString("base64")}`
      });
    }
    return { attachments, skipped };
  }

  async function respond(responseUrl: string, body: Record<string, unknown>): Promise<void> {
    await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  function callerFor(user: SignedInUser): McpCaller {
    return {
      clientName: "slack",
      actor: { userProfileId: user.userProfileId, appRole: user.appRole, siteRoles: user.siteRoles }
    };
  }

  // -- Connecting a Slack account ------------------------------------------

  function connectToken(teamId: string, slackUserId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ t: teamId, u: slackUserId, e: Math.floor(Date.now() / 1000) + CONNECT_TTL_SECONDS })
    ).toString("base64url");
    return `${payload}.${createHmac("sha256", connectKey).update(payload).digest("base64url")}`;
  }

  function readConnectToken(token: string): { teamId: string; slackUserId: string } | null {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(createHmac("sha256", connectKey).update(payload).digest("base64url"));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      if (typeof fields.t !== "string" || typeof fields.u !== "string" || typeof fields.e !== "number") return null;
      if (fields.e < Math.floor(Date.now() / 1000)) return null;
      return { teamId: fields.t, slackUserId: fields.u };
    } catch {
      return null;
    }
  }

  async function linkedUser(teamId: string, slackUserId: string): Promise<SignedInUser | null> {
    const row = await deps.sql
      .prepare<{ teamId: string; slackUserId: string }, { siteId: string; wordpressUserId: number }>(
        `SELECT site_id AS "siteId", wordpress_user_id AS "wordpressUserId" FROM slack_links
         WHERE team_id = @teamId AND slack_user_id = @slackUserId`
      )
      .get({ teamId, slackUserId });
    return row ? deps.auth.userFor(row.siteId, Number(row.wordpressUserId)) : null;
  }

  /** Only the person sees it: in a channel, an ephemeral message. */
  async function askToConnect(teamId: string, channel: string, slackUserId: string, isDirect: boolean, threadTs?: string) {
    const url = new URL(`/slack/connect?token=${connectToken(teamId, slackUserId)}`, deps.publicUrl).toString();
    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect your Slack account to SitePilot first: sign in with WordPress, and you'll act here with your WordPress role. Then mention me again."
        }
      },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Connect with WordPress" }, url, action_id: "connect", style: "primary" }]
      }
    ];
    const text = "Connect your Slack account to SitePilot first.";
    if (isDirect) {
      await slack("chat.postMessage", { channel, text, blocks, ...(threadTs ? { thread_ts: threadTs } : {}) });
    } else {
      await slack("chat.postEphemeral", { channel, user: slackUserId, text, blocks, ...(threadTs ? { thread_ts: threadTs } : {}) });
    }
  }

  /** GET shows who is connecting; POST links them. Both need a WordPress session. */
  async function connectPage(
    request: IncomingMessage,
    response: ServerResponse,
    user: SignedInUser,
    token: string,
    page: (title: string, body: string) => string
  ): Promise<void> {
    const target = readConnectToken(token);
    if (!target) {
      sendHtml(response, 400, page("Link expired", "<p>This connect link has expired. Mention @SitePilot in Slack again for a new one.</p>"));
      return;
    }
    let slackName = target.slackUserId;
    try {
      const info = (await slackRead("users.info", { user: target.slackUserId })) as { user?: { real_name?: string; name?: string } };
      slackName = info.user?.real_name || info.user?.name || slackName;
    } catch {
      // The ID is enough to go on.
    }
    if (request.method === "GET") {
      sendHtml(
        response,
        200,
        page(
          "Connect Slack",
          `<h1>Connect Slack to SitePilot?</h1>
           <p>The Slack account <strong>${e(slackName)}</strong> will act as <strong>${e(user.displayName)}</strong> (${e(user.login)})
             in SitePilot, with your WordPress role. ${user.siteRoles.includes("approve") ? "It will be able to approve changes with Slack's buttons." : "It will be able to make requests."}</p>
           <p class="muted">Only connect an account that's yours. You can disconnect it on your account page.</p>
           <form method="post" action="/slack/connect?token=${e(token)}" class="card">
             <button type="submit">Connect</button>
           </form>`
        )
      );
      return;
    }
    await deps.sql
      .prepare(
        `INSERT INTO slack_links (team_id, slack_user_id, site_id, wordpress_user_id, created_at)
         VALUES (@teamId, @slackUserId, @siteId, @wordpressUserId, @now)
         ON CONFLICT (team_id, slack_user_id) DO UPDATE SET site_id = @siteId, wordpress_user_id = @wordpressUserId, created_at = @now`
      )
      .run({ ...target, siteId: user.siteId, wordpressUserId: user.wordpressUserId, now: new Date().toISOString() });
    await slack("chat.postMessage", {
      channel: target.slackUserId,
      text: `You're connected to SitePilot as ${user.displayName}. Mention @SitePilot in a channel, or message me here, to ask about the site or to make a change.`
    }).catch(() => undefined);
    sendHtml(response, 200, page("Connected", "<h1>Connected</h1><p>Go back to Slack and mention @SitePilot again.</p>"));
  }

  async function disconnect(user: PersonRef): Promise<number> {
    const result = await deps.sql
      .prepare(`DELETE FROM slack_links WHERE site_id = @siteId AND wordpress_user_id = @wordpressUserId`)
      .run({ siteId: user.siteId, wordpressUserId: user.wordpressUserId });
    return result.changes;
  }

  async function linkedSlackAccounts(user: PersonRef): Promise<number> {
    const row = await deps.sql
      .prepare<{ siteId: string; wordpressUserId: number }, { count: number }>(
        `SELECT COUNT(*) AS count FROM slack_links WHERE site_id = @siteId AND wordpress_user_id = @wordpressUserId`
      )
      .get({ siteId: user.siteId, wordpressUserId: user.wordpressUserId });
    return Number(row?.count ?? 0);
  }

  // -- Threads ---------------------------------------------------------------

  async function threadFor(teamId: string, channelId: string, threadTs: string): Promise<ThreadRow | null> {
    return (
      (await deps.sql
        .prepare<{ teamId: string; channelId: string; threadTs: string }, ThreadRow>(
          `SELECT ${THREAD_COLUMNS}
           FROM slack_threads WHERE team_id = @teamId AND channel_id = @channelId AND thread_ts = @threadTs`
        )
        .get({ teamId, channelId, threadTs })) ?? null
    );
  }

  /** Records what the Slack thread holds now. Only requests are swept for updates. */
  async function saveThread(row: Omit<ThreadRow, "lastNotice" | "pendingText"> & { pendingText?: string }): Promise<void> {
    const now = new Date().toISOString();
    await deps.sql
      .prepare(
        `INSERT INTO slack_threads (team_id, channel_id, thread_ts, site_id, request_id, wordpress_user_id, last_notice, open,
           kind, pending_text, created_at, updated_at)
         VALUES (@teamId, @channelId, @threadTs, @siteId, @requestId, @wordpressUserId, NULL, @open, @kind, @pendingText, @now, @now)
         ON CONFLICT (team_id, channel_id, thread_ts) DO UPDATE SET request_id = @requestId,
           wordpress_user_id = @wordpressUserId, last_notice = NULL, open = @open, kind = @kind,
           pending_text = @pendingText, updated_at = @now`
      )
      .run({ ...row, pendingText: row.pendingText ?? null, open: row.kind === "request" ? 1 : 0, now });
  }

  async function markThread(row: ThreadRow, notice: string, open: boolean): Promise<void> {
    await deps.sql
      .prepare(
        `UPDATE slack_threads SET last_notice = @notice, open = @open, updated_at = @now
         WHERE team_id = @teamId AND channel_id = @channelId AND thread_ts = @threadTs`
      )
      .run({ teamId: row.teamId, channelId: row.channelId, threadTs: row.threadTs, notice, open: open ? 1 : 0, now: new Date().toISOString() });
  }

  async function reopenThread(row: ThreadRow): Promise<void> {
    await deps.sql
      .prepare(
        `UPDATE slack_threads SET open = 1, updated_at = @now
         WHERE team_id = @teamId AND channel_id = @channelId AND thread_ts = @threadTs`
      )
      .run({ teamId: row.teamId, channelId: row.channelId, threadTs: row.threadTs, now: new Date().toISOString() });
  }

  // -- Messages in and out ---------------------------------------------------

  async function startRequest(input: {
    teamId: string;
    channel: string;
    threadTs: string;
    user: SignedInUser;
    text: string;
    attachments: McpAttachment[];
    /** The post to change; a new draft without one. */
    post?: Extract<PostTarget, { kind: "existing" }>;
    /** Said before "On it", for example that the request moved to another post. */
    note?: string;
  }): Promise<void> {
    const created = await deps.backend.createRequest(
      {
        siteId: input.user.siteId,
        text: input.text,
        target: input.post?.target ?? { operation: "create_draft", postType: "post" },
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {})
      },
      callerFor(input.user)
    );
    if (!created.ok) {
      await slack("chat.postMessage", { channel: input.channel, thread_ts: input.threadTs, text: `SitePilot couldn't start that: ${created.message}` });
      return;
    }
    await saveThread({
      teamId: input.teamId,
      channelId: input.channel,
      threadTs: input.threadTs,
      siteId: input.user.siteId,
      requestId: created.status.requestId,
      wordpressUserId: input.user.wordpressUserId,
      kind: "request"
    });
    // The post is named before anything is planned, so a wrong guess shows straight away.
    await slack("chat.postMessage", {
      channel: input.channel,
      thread_ts: input.threadTs,
      text: `${input.note ? `${input.note} ` : ""}On it: ${input.post ? `changing ${input.post.label}` : "a new draft"}. SitePilot is planning the change and building a preview; it'll appear in this thread. Reply here to change anything.`
    });
  }

  /**
   * Which post the message means: one it names ("post 102", its link), the
   * latest post, or a new draft when it asks for new content. Anything else
   * is unknown, and the thread asks rather than guessing.
   */
  /** Whether the post is live now. False when it can't be read, so the button still shows. */
  async function isPublished(user: SignedInUser, postId: number): Promise<boolean> {
    const getPost = findReadTool("get_post");
    if (!getPost) return false;
    const found = await deps.backend
      .lookup({ siteId: user.siteId, tool: getPost, args: { post_id: postId } }, callerFor(user))
      .catch(() => null);
    return found?.ok === true && (found.result as Record<string, unknown>).post_status === "publish";
  }

  /** Links to the site itself; a link elsewhere is content, not a post to change. */
  async function siteLinks(user: SignedInUser, text: string): Promise<URL[]> {
    const links = mentionedLinks(text);
    if (links.length === 0) return [];
    const site = await getDatabase().repositories.sites.getById(user.siteId as never);
    const host = site ? new URL(site.baseUrl).host : null;
    return links.filter((link) => link.host === host);
  }

  async function resolvePost(user: SignedInUser, text: string): Promise<PostTarget> {
    if (wantsNewPost(text)) return { kind: "new" };
    const getPost = findReadTool("get_post");
    const findPosts = findReadTool("find_posts");
    if (!getPost || !findPosts) return { kind: "unknown" };
    const caller = callerFor(user);
    const lookup = async (tool: NonNullable<typeof getPost>, args: Record<string, unknown>) => {
      const found = await deps.backend.lookup({ siteId: user.siteId, tool, args: sanitizeReadToolArguments(tool, args) }, caller);
      return found.ok ? (found.result as Record<string, unknown>) : null;
    };
    const id = mentionedPostId(text);
    let args: Record<string, unknown> | null = id !== null ? { post_id: id } : null;
    if (!args) {
      // A link to the post: its slug is the last part of the address.
      const slug = (await siteLinks(user, text))
        .map((link) => link.pathname.split("/").filter(Boolean).at(-1) ?? "")
        .find((part) => /^[a-z0-9-]+$/i.test(part));
      if (slug) args = { slug, post_type: "any" };
    }
    if (!args) {
      const latest = asksForLatest(text);
      if (latest) {
        const found = await lookup(findPosts, { post_type: latest, status: "any", orderby: "date", order: "DESC", limit: 1 });
        const first = Array.isArray(found?.matches) ? (found.matches[0] as Record<string, unknown> | undefined) : undefined;
        if (typeof first?.post_id === "number") args = { post_id: first.post_id };
      }
    }
    if (!args) return { kind: "unknown" };
    const post = await lookup(getPost, args);
    if (!post || typeof post.post_id !== "number") {
      return { kind: "unknown", problem: id !== null ? `SitePilot can't find post ${id}.` : "SitePilot couldn't find that post." };
    }
    if (post.post_type !== "post" && post.post_type !== "page") {
      return { kind: "unknown", problem: `${post.post_id} is ${String(post.post_type)}, not a post or page.` };
    }
    const postType = post.post_type;
    return {
      kind: "existing",
      target: { operation: "edit", postType, postId: post.post_id },
      label: `${postType} ${post.post_id}${typeof post.post_title === "string" && post.post_title ? ` “${post.post_title}”` : ""}`
    };
  }

  /** The post isn't clear: ask, and keep the message until it is. */
  async function askWhichPost(input: ThreadStart, problem?: string): Promise<void> {
    await saveThread({
      teamId: input.teamId,
      channelId: input.channel,
      threadTs: input.threadTs,
      siteId: input.user.siteId,
      requestId: "",
      wordpressUserId: input.user.wordpressUserId,
      kind: "choosing_post",
      pendingText: input.text
    });
    await slack("chat.postMessage", {
      channel: input.channel,
      thread_ts: input.threadTs,
      text: `${problem ? `${problem} ` : ""}Which post is this for? Reply with its number (for example *post 102*) or its link, or *new* for a new draft.`
    });
  }

  /** Starts a change once its post is known, or asks which post. */
  async function startChange(input: ThreadStart, attachments: McpAttachment[]): Promise<void> {
    const post = await resolvePost(input.user, input.text);
    if (post.kind === "unknown") return askWhichPost(input, post.problem);
    return startRequest({ ...input, attachments, ...(post.kind === "existing" ? { post } : {}) });
  }

  type ThreadStart = { teamId: string; channel: string; threadTs: string; user: SignedInUser; text: string };

  /** A question's answer, with what to do next on the first one. */
  function answerBlocks(answer: string, first: boolean): SlackBlock[] {
    const body = answer.trim() || "SitePilot had nothing to say to that.";
    return [
      { type: "section", text: { type: "mrkdwn", text: md(body.length > MAX_SECTION ? `${body.slice(0, MAX_SECTION)}…` : body) } },
      ...(first
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "Reply here to ask more; this only looks things up. To change something, send a new message, or start one with *change:*"
                }
              ]
            }
          ]
        : [])
    ];
  }

  /** A read-only question about the site, answered in the thread. */
  async function startConversation(input: ThreadStart, record = true): Promise<void> {
    const created = await deps.backend.createConversation(
      { siteId: input.user.siteId, question: input.text },
      callerFor(input.user)
    );
    if (!created.ok) {
      await slack("chat.postMessage", { channel: input.channel, thread_ts: input.threadTs, text: `SitePilot couldn't look that up: ${created.message}` });
      return;
    }
    if (record) {
      await saveThread({
        teamId: input.teamId,
        channelId: input.channel,
        threadTs: input.threadTs,
        siteId: input.user.siteId,
        requestId: created.threadId,
        wordpressUserId: input.user.wordpressUserId,
        kind: "conversation"
      });
    }
    await slack("chat.postMessage", {
      channel: input.channel,
      thread_ts: input.threadTs,
      text: created.answer.slice(0, 3_000),
      blocks: answerBlocks(created.answer, record),
      unfurl_links: false
    });
    if (record) await rememberAnswer(input.teamId, input.channel, input.threadTs, created.answer);
  }

  /** A conversation keeps its latest answer, to suggest the post when a change comes up. */
  async function rememberAnswer(teamId: string, channelId: string, threadTs: string, answer: string): Promise<void> {
    await deps.sql
      .prepare(
        `UPDATE slack_threads SET last_notice = @answer, updated_at = @now
         WHERE team_id = @teamId AND channel_id = @channelId AND thread_ts = @threadTs AND kind = 'conversation'`
      )
      .run({ teamId, channelId, threadTs, answer: answer.slice(0, 2_000), now: new Date().toISOString() });
  }

  /** The wording didn't say: ask, with a button for each. */
  async function askWhich(input: ThreadStart): Promise<void> {
    await saveThread({
      teamId: input.teamId,
      channelId: input.channel,
      threadTs: input.threadTs,
      siteId: input.user.siteId,
      requestId: "",
      wordpressUserId: input.user.wordpressUserId,
      kind: "choosing",
      pendingText: input.text
    });
    const value = JSON.stringify({ t: input.threadTs });
    await slack("chat.postMessage", {
      channel: input.channel,
      thread_ts: input.threadTs,
      text: "Do you want an answer about the site, or a change to it?",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Do you want an answer about the site, or a change to it?" } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Answer a question" }, action_id: "route_ask", value },
            { type: "button", text: { type: "plain_text", text: "Make a change" }, action_id: "route_change", value }
          ]
        },
        { type: "context", elements: [{ type: "mrkdwn", text: "Or reply *ask* or *change*. A change still needs approving before anything is written." }] }
      ]
    });
  }

  /** Starts what a message turned out to be, in its thread. */
  async function startAs(kind: "conversation" | "request", input: ThreadStart, attachments: McpAttachment[] = []): Promise<void> {
    return kind === "conversation" ? startConversation(input) : startChange(input, attachments);
  }

  /** The files on the message that started the thread, for a change decided later. */
  async function rootAttachments(channel: string, threadTs: string): Promise<McpAttachment[]> {
    return (await attachmentsOf({ channel, ts: threadTs }).catch(() => ({ attachments: [] as McpAttachment[] }))).attachments;
  }

  /** A reply in a thread SitePilot already answered. */
  async function replyIn(row: ThreadRow, user: SignedInUser, text: string, attachments: McpAttachment[]): Promise<void> {
    const start: ThreadStart = { teamId: row.teamId, channel: row.channelId, threadTs: row.threadTs, user, text };
    const route = routeSlackMessage(text, { hasAttachments: attachments.length > 0 });
    if (row.kind === "choosing") {
      const choice = routeChoice(text);
      if (choice) return startAs(choice, { ...start, text: row.pendingText ?? text });
      // A new message instead of an answer: work that one out.
      return route.kind === "unsure" ? askWhich({ ...start, text: route.text }) : startAs(route.kind, { ...start, text: route.text }, attachments);
    }
    if (row.kind === "choosing_post") {
      const pending = { ...start, text: row.pendingText ?? text };
      const files = attachments.length > 0 ? attachments : await rootAttachments(row.channelId, row.threadTs);
      if (/^\s*(?:new|a new one|new (?:post|draft|page)|a new (?:post|draft|page))\s*[.!]?\s*$/i.test(text) || wantsNewPost(text)) {
        return startRequest({ ...pending, attachments: files });
      }
      const post = await resolvePost(user, text);
      if (post.kind === "existing") return startRequest({ ...pending, attachments: files, post });
      if (post.kind === "new") return startRequest({ ...pending, attachments: files });
      return askWhichPost(pending, post.problem ?? "SitePilot couldn't tell which post that is.");
    }
    if (row.kind === "conversation") {
      // A change gets its own thread, so a request never inherits a conversation.
      if (route.kind === "request") {
        const postId = onlyPostIdIn(row.lastNotice ?? "");
        await slack("chat.postMessage", {
          channel: row.channelId,
          thread_ts: row.threadTs,
          text: `This thread only looks things up, so a change needs its own thread. Send it as a new message to SitePilot${
            postId === null ? ", naming the post (for example *post 102*)" : `, for example: *post ${postId}: ${md(route.text.slice(0, 200))}*`
          }.`
        });
        return;
      }
      const asked = await deps.backend.ask({ siteId: row.siteId, threadId: row.requestId, question: text }, callerFor(user));
      await slack("chat.postMessage", {
        channel: row.channelId,
        thread_ts: row.threadTs,
        text: asked.ok ? asked.answer.slice(0, 3_000) : `SitePilot couldn't look that up: ${asked.message}`,
        ...(asked.ok ? { blocks: answerBlocks(asked.answer, false) } : {}),
        unfurl_links: false
      });
      if (asked.ok) await rememberAnswer(row.teamId, row.channelId, row.threadTs, asked.answer);
      return;
    }
    // In a request's thread, "ask …" gets an answer without touching the request.
    if (route.kind === "conversation" && route.forced) return startConversation({ ...start, text: route.text }, false);
    // Naming a different post asks to move the request there, rather than
    // carrying on with the wrong one or guessing.
    if (mentionedPostId(text) !== null || (await siteLinks(user, text)).length > 0) {
      const asked = await proposeMove(row, user, text);
      if (asked) return;
    }
    return reply(row, user, text, attachments);
  }

  /** The post the request is for now: its target, or the draft it wrote. */
  function currentPostOf(status: McpRequestStatus): number | undefined {
    return status.target && "postId" in status.target ? status.target.postId : status.result?.postId;
  }

  /**
   * A reply that names another post than the request's: ask whether to move
   * the request there. False when it names the same post.
   */
  async function proposeMove(row: ThreadRow, user: SignedInUser, text: string): Promise<boolean> {
    const current = await deps.backend.requestStatus({ siteId: row.siteId, requestId: row.requestId }, callerFor(user));
    if (!current.ok) return false;
    const post = await resolvePost(user, text);
    if (post.kind === "new") return false;
    if (post.kind === "unknown") {
      await slack("chat.postMessage", {
        channel: row.channelId,
        thread_ts: row.threadTs,
        text: `${post.problem ?? "SitePilot couldn't tell which post that is."} Nothing was changed; reply with the post's number or link.`
      });
      return true;
    }
    const currentPost = currentPostOf(current.status);
    if (post.target.postId === currentPost) return false;
    await setPending(row, text);
    const value = JSON.stringify({ p: post.target.postId });
    const now = currentPost ? `post ${currentPost}` : "a new draft";
    await slack("chat.postMessage", {
      channel: row.channelId,
      thread_ts: row.threadTs,
      text: `Move this request to ${post.label}? It's for ${now} now.`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Move this request to *${md(post.label)}*? It's for ${now} now.` } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: `Move to post ${post.target.postId}` }, style: "primary", action_id: "route_move", value },
            { type: "button", text: { type: "plain_text", text: `Keep ${now}` }, action_id: "route_keep", value }
          ]
        }
      ]
    });
    return true;
  }

  async function setPending(row: ThreadRow, text: string | null): Promise<void> {
    await deps.sql
      .prepare(
        `UPDATE slack_threads SET pending_text = @text, updated_at = @now
         WHERE team_id = @teamId AND channel_id = @channelId AND thread_ts = @threadTs`
      )
      .run({ teamId: row.teamId, channelId: row.channelId, threadTs: row.threadTs, text, now: new Date().toISOString() });
  }

  /**
   * Starts the request again on another post, in this thread, with the
   * person's messages so far, and rejects the old preview so it can't be
   * applied by mistake.
   */
  async function moveRequest(row: ThreadRow, user: SignedInUser, text: string, post: Extract<PostTarget, { kind: "existing" }>): Promise<void> {
    const caller = callerFor(user);
    const current = await deps.backend.requestStatus({ siteId: row.siteId, requestId: row.requestId }, caller);
    if (!current.ok) {
      await slack("chat.postMessage", { channel: row.channelId, thread_ts: row.threadTs, text: `SitePilot couldn't move it: ${current.message}` });
      return;
    }
    const status = current.status;
    const currentPost = currentPostOf(status);
    let withdrawn = "";
    if (status.state === "awaiting_approval" || status.state === "preparing_preview") {
      const subject = await deps.backend.approvalSubject?.({ siteId: row.siteId, requestId: row.requestId }, caller);
      const rejected =
        subject?.ok && user.siteRoles.includes("approve")
          ? await deps.backend.decideForPerson?.(
              { siteId: row.siteId, requestId: row.requestId, candidateId: subject.candidateId, decision: "reject", note: `Moved to ${post.label}.`, channel: "slack_button" },
              caller
            )
          : undefined;
      withdrawn = rejected?.ok
        ? ` The earlier preview${currentPost ? ` for post ${currentPost}` : ""} was rejected, so it can't be applied.`
        : ` The earlier preview${currentPost ? ` for post ${currentPost}` : ""} is still waiting: reject it if you don't need it.`;
    }
    // The whole request so far, with this correction, as the new request's text.
    const earlier = status.recentMessages.filter((message) => message.from === "you").map((message) => message.text);
    const fullText = [...earlier.filter((message) => message !== text), text].join("\n\n");
    await startRequest({
      teamId: row.teamId,
      channel: row.channelId,
      threadTs: row.threadTs,
      user,
      text: fullText,
      attachments: await rootAttachments(row.channelId, row.threadTs),
      post,
      note: `Moving this to ${post.label}.${withdrawn}`
    });
  }

  async function reply(row: ThreadRow, user: SignedInUser, text: string, attachments: McpAttachment[]): Promise<void> {
    const caller = callerFor(user);
    const current = await deps.backend.requestStatus({ siteId: row.siteId, requestId: row.requestId }, caller);
    const waiting = current.ok && (current.status.state === "awaiting_approval" || current.status.state === "approved");
    const added = await deps.backend.addToRequest(
      { siteId: row.siteId, requestId: row.requestId, text, ...(attachments.length > 0 ? { attachments } : {}) },
      caller
    );
    if (!added.ok) {
      await slack("chat.postMessage", { channel: row.channelId, thread_ts: row.threadTs, text: `SitePilot couldn't take that: ${added.message}` });
      return;
    }
    if (waiting && isTypedApproval(text)) {
      // SitePilot ignores it too; nothing is rebuilt or approved.
      await slack("chat.postMessage", {
        channel: row.channelId,
        thread_ts: row.threadTs,
        text: "Typing doesn't approve a change. Use the Approve button on the review in this thread. Nothing was changed."
      });
      return;
    }
    await reopenThread(row);
  }

  function withoutMentions(text: string): string {
    return text.replace(/<@[A-Z0-9]+>/g, "").trim();
  }

  async function handleMessage(event: {
    type: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
    files?: SlackFile[];
  }, teamId: string): Promise<void> {
    // Messages with files arrive as "file_share"; other subtypes are edits, joins and the like.
    if (event.bot_id || (event.subtype && event.subtype !== "file_share") || !event.user || !event.channel || !event.ts) return;
    const isDirect = event.channel_type === "im";
    const raw = event.text ?? "";
    // A mention in a channel arrives as both app_mention and message: answer the mention.
    if (event.type === "message" && !isDirect && botUserId && raw.includes(`<@${botUserId}>`)) return;
    const text = withoutMentions(raw);
    const existing = event.thread_ts ? await threadFor(teamId, event.channel, event.thread_ts) : null;
    if (event.type === "message" && !isDirect && !existing) return;
    if (!text) return;
    const user = await linkedUser(teamId, event.user);
    if (!user) {
      console.log("Slack: not connected yet; sending the connect link.");
      return askToConnect(teamId, event.channel, event.user, isDirect, event.thread_ts ?? (isDirect ? undefined : event.ts));
    }
    const { attachments, skipped } = await attachmentsOf(event);
    const threadTs = existing?.threadTs ?? event.thread_ts ?? event.ts;
    if (skipped.length > 0) {
      await slack("chat.postMessage", {
        channel: event.channel,
        thread_ts: threadTs,
        text: `SitePilot couldn't use ${skipped.join(", ")}.`
      }).catch(() => undefined);
    }
    if (existing) return replyIn(existing, user, text, attachments);
    const start: ThreadStart = { teamId, channel: event.channel, threadTs, user, text };
    const route = routeSlackMessage(text, { hasAttachments: attachments.length > 0 });
    console.log(`Slack: new thread, ${route.kind}${route.kind !== "unsure" && route.forced ? " (asked for)" : ""}.`);
    if (route.kind === "unsure") return askWhich(start);
    return startAs(route.kind, { ...start, text: route.text }, attachments);
  }

  function reviewBlocks(status: McpRequestStatus, candidateId: string): SlackBlock[] {
    const lines: string[] = [];
    if (status.changes) {
      lines.push(
        `${OPERATION_LABELS[status.changes.operation] ?? status.changes.operation}${status.changes.title ? `: “${status.changes.title}”` : ""}`
      );
      if (status.changes.excerpt) lines.push(status.changes.excerpt);
      for (const item of status.changes.seo ?? []) lines.push(`${item.label}: ${item.value}`);
      if (status.changes.featuredImage) lines.push(`Featured image: ${status.changes.featuredImage}`);
      for (const item of status.changes.terms ?? []) lines.push(`${item.label}: ${item.value}`);
    }
    const previews = (status.reviewArtifacts ?? []).filter((artifact) => artifact.kind === "preview" && artifact.url);
    const value = JSON.stringify({ r: status.requestId, c: candidateId });
    return [
      { type: "section", text: { type: "mrkdwn", text: `*Ready for review:* ${md(status.title)}` } },
      ...(lines.length > 0 ? [{ type: "section", text: { type: "mrkdwn", text: lines.map((line) => `• ${md(line)}`).join("\n") } }] : []),
      ...previews.map((artifact, index) => ({
        type: "image",
        image_url: artifact.url,
        alt_text: index === 0 ? "Desktop preview" : "Mobile preview",
        title: { type: "plain_text", text: index === 0 ? "Desktop preview" : index === 1 ? "Mobile preview" : `Preview ${index + 1}` }
      })),
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Approve and apply" }, style: "primary", action_id: "approve", value },
          { type: "button", text: { type: "plain_text", text: "Reject" }, style: "danger", action_id: "reject", value }
        ]
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Approving applies it to the site straight away. Only a click on Approve, by someone who can publish, approves it." }]
      }
    ];
  }

  /** Posts what changed on each open request: its review, a question, or the result. */
  async function sweep(): Promise<void> {
    if (sweeping || !deps.config) return;
    sweeping = true;
    try {
      const rows = await deps.sql
        .prepare<Record<string, never>, ThreadRow>(
          `SELECT ${THREAD_COLUMNS}
           FROM slack_threads WHERE open = 1 AND kind = 'request' ORDER BY updated_at DESC LIMIT 50`
        )
        .all({});
      for (const row of rows) {
        try {
          await sweepThread(row);
        } catch (error) {
          console.log(`Slack thread ${row.threadTs} update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      sweeping = false;
    }
  }

  async function sweepThread(row: ThreadRow): Promise<void> {
    const owner = await deps.auth.userFor(row.siteId, row.wordpressUserId);
    if (!owner) return markThread(row, "owner_gone", false);
    const caller = callerFor(owner);
    const found = await deps.backend.requestStatus({ siteId: row.siteId, requestId: row.requestId }, caller);
    if (!found.ok) return markThread(row, `missing:${found.code}`, false);
    const status = found.status;
    const post = (text: string, blocks?: SlackBlock[]) =>
      slack("chat.postMessage", { channel: row.channelId, thread_ts: row.threadTs, text, ...(blocks ? { blocks } : {}), unfurl_links: false });

    if (status.state === "awaiting_approval") {
      const subject = await deps.backend.approvalSubject?.({ siteId: row.siteId, requestId: row.requestId }, caller);
      if (!subject?.ok) return;
      const notice = `review:${subject.candidateId}`;
      if (row.lastNotice === notice) return;
      await post(`Ready for review: ${status.title}`, reviewBlocks(subject.status, subject.candidateId));
      return markThread(row, notice, true);
    }
    if (status.state === "needs_your_reply" && status.question) {
      const notice = `question:${status.question}`;
      if (row.lastNotice === notice) return;
      await post(`SitePilot asks: ${status.question}\nReply in this thread.`);
      return markThread(row, notice, true);
    }
    if (status.state === "completed") {
      // One thread can finish more than once: a draft, then publishing it.
      const notice = `completed:${status.target?.operation ?? ""}:${status.result?.postId ?? ""}:${status.updatedAt}`;
      if (row.lastNotice === notice) return;
      const editLink = status.result?.editUrl ? ` <${status.result.editUrl}|Open it in WordPress>` : "";
      const published = status.target?.operation === "publish";
      const canPublish =
        status.result?.postId !== undefined &&
        (status.target?.operation === "create_draft" || status.target?.operation === "edit" || status.target?.operation === "replace") &&
        // An edit to a live post is live already: nothing to publish.
        !(await isPublished(owner, status.result.postId));
      await post(`Done. Written to the site and verified.`, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${published ? "Published" : status.target?.operation === "unpublish" ? "Unpublished" : "Done"}. Written to the site and verified.${editLink}`
          }
        },
        ...(canPublish
          ? [
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Publish it" },
                    action_id: "publish",
                    value: JSON.stringify({ p: status.result?.postId, t: status.target?.postType ?? "post" })
                  }
                ]
              }
            ]
          : [])
      ]);
      return markThread(row, notice, false);
    }
    if (status.state === "rejected") {
      const notice = `rejected:${status.updatedAt}`;
      if (row.lastNotice === notice) return;
      await post("Rejected. Nothing was written to the site. Reply in this thread to try something else.");
      return markThread(row, notice, false);
    }
    if (status.state === "needs_attention") {
      const notice = `attention:${status.updatedAt}`;
      if (row.lastNotice === notice) return;
      // SitePilot's own explanation, as the app shows it, not the technical error.
      const explained = [...status.recentMessages].reverse().find((message) => message.from !== "you")?.text;
      await post(`${explained ?? status.failure?.message ?? status.summary}\n\nReply in this thread to try again.`);
      return markThread(row, notice, false);
    }
  }

  // -- Buttons -----------------------------------------------------------------

  async function handleAction(payload: {
    team?: { id?: string };
    user?: { id?: string };
    channel?: { id?: string };
    container?: { thread_ts?: string; message_ts?: string };
    message?: { ts?: string; thread_ts?: string; blocks?: SlackBlock[] };
    response_url?: string;
    actions?: Array<{ action_id?: string; value?: string }>;
  }): Promise<void> {
    const action = payload.actions?.[0];
    const teamId = payload.team?.id ?? "";
    const slackUserId = payload.user?.id ?? "";
    const channel = payload.channel?.id ?? "";
    const responseUrl = payload.response_url ?? "";
    const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts ?? "";
    if (!action || action.action_id === "connect" || !responseUrl) return;
    const tell = (text: string) => respond(responseUrl, { response_type: "ephemeral", replace_original: false, text });
    const user = await linkedUser(teamId, slackUserId);
    if (!user) {
      await askToConnect(teamId, channel, slackUserId, false, threadTs);
      return;
    }
    let value: Record<string, unknown> = {};
    try {
      value = JSON.parse(action.value ?? "{}") as Record<string, unknown>;
    } catch {
      return tell("That button didn't carry what SitePilot needs.");
    }
    // The clicked message, without its buttons, plus who did what.
    const settle = (note: string) =>
      respond(responseUrl, {
        replace_original: true,
        text: note,
        blocks: [
          ...(payload.message?.blocks ?? []).filter((block) => block.type !== "actions" && block.type !== "context"),
          { type: "context", elements: [{ type: "mrkdwn", text: note }] }
        ]
      });

    if (action.action_id === "approve" || action.action_id === "reject") {
      const decision = action.action_id === "approve" ? "approve" : "reject";
      const decideForPerson = deps.backend.decideForPerson;
      if (!decideForPerson || typeof value.r !== "string" || typeof value.c !== "string") return tell("This review can't be decided here.");
      const result = await decideForPerson(
        { siteId: user.siteId, requestId: value.r, candidateId: value.c, decision, channel: "slack_button" },
        callerFor(user)
      );
      if (!result.ok) return tell(`Not done: ${result.message}`);
      return settle(
        decision === "approve"
          ? `Approved by <@${slackUserId}>. SitePilot is applying it now.`
          : `Rejected by <@${slackUserId}>. Nothing was written.`
      );
    }
    if (action.action_id === "route_ask" || action.action_id === "route_change") {
      const row = threadTs ? await threadFor(teamId, channel, threadTs) : null;
      if (!row || row.kind !== "choosing" || !row.pendingText) return tell("That's already been answered.");
      const kind = action.action_id === "route_ask" ? "conversation" : "request";
      await settle(kind === "conversation" ? `<@${slackUserId}> asked for an answer.` : `<@${slackUserId}> asked for a change.`);
      return startAs(kind, { teamId, channel, threadTs: row.threadTs, user, text: row.pendingText });
    }
    if (action.action_id === "route_move" || action.action_id === "route_keep") {
      const row = threadTs ? await threadFor(teamId, channel, threadTs) : null;
      if (!row || row.kind !== "request" || !row.pendingText) return tell("That's already been answered.");
      const pending = row.pendingText;
      await setPending(row, null);
      if (action.action_id === "route_keep") {
        return settle(`<@${slackUserId}> kept this request where it is. Reply with what you'd like changed.`);
      }
      const post = await resolvePost(user, `post ${Number(value.p)}`);
      if (post.kind !== "existing") return tell(`Not moved: ${post.kind === "unknown" ? (post.problem ?? "that post can't be found") : "no post named"}.`);
      await settle(`<@${slackUserId}> moved this request to ${post.label}.`);
      return moveRequest(row, user, pending, post);
    }
    if (action.action_id === "publish") {
      const postId = Number(value.p);
      if (!Number.isInteger(postId) || postId < 1) return tell("This button doesn't say which post to publish.");
      const row = threadTs ? await threadFor(teamId, channel, threadTs) : null;
      if (!row) return tell("Publish from the request's thread.");
      // In the same SitePilot request thread, as typing "publish it" there
      // would: SitePilot publishes the post this thread wrote, as its own
      // approved step.
      const added = await deps.backend.addToRequest(
        { siteId: row.siteId, requestId: row.requestId, text: "Publish it." },
        callerFor(user)
      );
      if (!added.ok) return tell(`Not done: ${added.message}`);
      await reopenThread(row);
      return settle(`Publishing requested by <@${slackUserId}>. SitePilot will ask for approval in this thread.`);
    }
  }

  // -- HTTP ------------------------------------------------------------------------

  async function verified(request: IncomingMessage): Promise<string | null> {
    const body = await readBody(request, 1_000_000);
    if (!deps.config) return null;
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    return verifySlackSignature({
      body,
      timestamp: header("x-slack-request-timestamp"),
      signature: header("x-slack-signature"),
      signingSecret: deps.config.signingSecret,
      nowSeconds: Math.floor(Date.now() / 1000)
    })
      ? body
      : null;
  }

  async function handleEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, 1_000_000);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      send(response, 400, "Invalid JSON.", { "content-type": "text/plain" });
      return;
    }
    // Slack checks the address when the app is set up, before its secret is
    // here. Echoing the challenge does nothing else.
    if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
      send(response, 200, JSON.stringify({ challenge: parsed.challenge }), { "content-type": "application/json" });
      return;
    }
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    if (
      !deps.config ||
      !verifySlackSignature({
        body,
        timestamp: header("x-slack-request-timestamp"),
        signature: header("x-slack-signature"),
        signingSecret: deps.config.signingSecret,
        nowSeconds: Math.floor(Date.now() / 1000)
      })
    ) {
      const skew = Math.floor(Date.now() / 1000) - Number(header("x-slack-request-timestamp"));
      console.log(
        `Slack event refused: ${!deps.config ? "Slack isn't configured" : `signature didn't match SLACK_SIGNING_SECRET (clock skew ${Number.isFinite(skew) ? skew : "?"}s)`}.`
      );
      send(response, 401, "Not from Slack.", { "content-type": "text/plain" });
      return;
    }
    // Slack wants an answer within three seconds; the work happens after it.
    send(response, 200, "", { "content-type": "text/plain" });
    if (header("x-slack-retry-num")) return;
    const event = parsed.event as Record<string, unknown> | undefined;
    if (parsed.type !== "event_callback" || !event) return;
    console.log(`Slack event: ${String(event.type)}${event.subtype ? `/${String(event.subtype)}` : ""} in ${String(event.channel_type ?? "channel")}.`);
    void (async () => {
      if (!botUserId) {
        const identity = await slack("auth.test", {}).catch(() => null);
        botUserId = typeof identity?.user_id === "string" ? identity.user_id : undefined;
      }
      if (event.type === "app_mention" || event.type === "message") {
        await handleMessage(event as Parameters<typeof handleMessage>[0], String(parsed.team_id ?? ""));
      }
    })().catch((error: unknown) => console.log(`Slack event failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async function handleInteractions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await verified(request);
    if (body === null) {
      console.log("Slack action refused: signature didn't match SLACK_SIGNING_SECRET, or Slack isn't configured.");
      send(response, 401, "Not from Slack.", { "content-type": "text/plain" });
      return;
    }
    send(response, 200, "", { "content-type": "text/plain" });
    const payloadText = new URLSearchParams(body).get("payload") ?? "{}";
    void (async () => {
      const payload = JSON.parse(payloadText) as { type?: string } & Parameters<typeof handleAction>[0];
      if (payload.type === "block_actions") await handleAction(payload);
    })().catch((error: unknown) => console.log(`Slack action failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  return {
    enabled: deps.config !== null,
    handleEvents,
    handleInteractions,
    connectPage,
    disconnect,
    linkedSlackAccounts,
    sweep,
    start(): void {
      if (!deps.config) return;
      const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
      timer.unref();
    }
  };
}

export type SlackApp = ReturnType<typeof createSlackApp>;
