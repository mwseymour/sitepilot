import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isTypedApproval } from "@sitepilot/core/request-ingress-service";
import type { McpAttachment, McpCaller, McpRequestStatus, SitePilotMcpBackend } from "@sitepilot/mcp-server";
import type { SqlConnection } from "@sitepilot/sql";

import type { AuthStore, PersonRef, SignedInUser } from "./auth.js";
import { escapeHtml as e, readBody, send, sendHtml } from "./http.js";

/**
 * SitePilot in Slack: mention @SitePilot (or DM it) to make a request. The
 * request's thread gets its previews, Approve and Reject buttons, questions
 * and the result. People connect their Slack account once, by signing in with
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

type ThreadRow = {
  teamId: string;
  channelId: string;
  threadTs: string;
  siteId: string;
  requestId: string;
  wordpressUserId: number;
  lastNotice: string | null;
};

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
      text: `You're connected to SitePilot as ${user.displayName}. Mention @SitePilot in a channel, or message me here, to make a request.`
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
          `SELECT team_id AS "teamId", channel_id AS "channelId", thread_ts AS "threadTs", site_id AS "siteId",
             request_id AS "requestId", wordpress_user_id AS "wordpressUserId", last_notice AS "lastNotice"
           FROM slack_threads WHERE team_id = @teamId AND channel_id = @channelId AND thread_ts = @threadTs`
        )
        .get({ teamId, channelId, threadTs })) ?? null
    );
  }

  async function saveThread(row: Omit<ThreadRow, "lastNotice">): Promise<void> {
    const now = new Date().toISOString();
    await deps.sql
      .prepare(
        `INSERT INTO slack_threads (team_id, channel_id, thread_ts, site_id, request_id, wordpress_user_id, last_notice, open, created_at, updated_at)
         VALUES (@teamId, @channelId, @threadTs, @siteId, @requestId, @wordpressUserId, NULL, 1, @now, @now)
         ON CONFLICT (team_id, channel_id, thread_ts) DO UPDATE SET request_id = @requestId,
           wordpress_user_id = @wordpressUserId, last_notice = NULL, open = 1, updated_at = @now`
      )
      .run({ ...row, now });
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
  }): Promise<void> {
    const created = await deps.backend.createRequest(
      {
        siteId: input.user.siteId,
        text: input.text,
        target: { operation: "create_draft", postType: "post" },
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
      wordpressUserId: input.user.wordpressUserId
    });
    await slack("chat.postMessage", {
      channel: input.channel,
      thread_ts: input.threadTs,
      text: "On it. SitePilot is planning the change and building a preview; it'll appear in this thread. Reply here to change anything."
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
    if (existing) return reply(existing, user, text, attachments);
    return startRequest({ teamId, channel: event.channel, threadTs, user, text, attachments });
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
          `SELECT team_id AS "teamId", channel_id AS "channelId", thread_ts AS "threadTs", site_id AS "siteId",
             request_id AS "requestId", wordpress_user_id AS "wordpressUserId", last_notice AS "lastNotice"
           FROM slack_threads WHERE open = 1 ORDER BY updated_at DESC LIMIT 50`
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
        (status.target?.operation === "create_draft" || status.target?.operation === "edit" || status.target?.operation === "replace");
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
