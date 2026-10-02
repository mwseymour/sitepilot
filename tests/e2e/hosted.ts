/**
 * The hosted server end to end, locally: the server on a disposable Postgres
 * database, managing the MAMP site.
 *
 * 1. Connect the site with a fresh registration code.
 * 2. Sign in with WordPress in a real browser (login, confirm, back).
 * 3. Create a personal MCP token and use the MCP server with it. Then
 *    connect over OAuth as claude.ai does: discovery, registration, sign-in
 *    and consent, scoped tokens, refresh, and disconnecting.
 * 4. Make a request in the app (the desktop interface, served by the
 *    server), approve and apply it there, and see it in WordPress.
 * 4c. Slack, against a stand-in for Slack's API: connecting; a question
 *    answered in its thread, with a follow-up; a message that could be
 *    either, settled with a button; a request in a thread with its previews
 *    and buttons, a typed "approved" doing nothing, and Approve applying it.
 * 5. Sign in as a WordPress contributor (can edit, can't publish): a
 *    requester, refused approving and site setup. Then the admin area: the
 *    contributor can't open it; the admin makes them an approver, turns
 *    their access off and back, and revokes a token. (Needs wp-cli, for the
 *    test user's password.)
 *
 * Needs SITEPILOT_TEST_POSTGRES_URL (the local Docker Postgres), an OpenAI
 * key for the planner, and SITEPILOT_E2E_WP_PATH for fresh registration codes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";

import { createTestPostgresDatabase } from "../postgres-test-database.js";
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_BASE_URL,
  E2E_OPENAI_API_KEY,
  E2E_WP_PATH
} from "./config.js";
import { currentRegistrationCode } from "./registration.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = 18090;
const SERVER = `http://localhost:${PORT}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(label: string, check: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main(): Promise<void> {
  assert(process.env.SITEPILOT_TEST_POSTGRES_URL, "Set SITEPILOT_TEST_POSTGRES_URL to the local test Postgres.");
  assert(E2E_OPENAI_API_KEY, "The planner needs OPENAI_API_KEY or openAiApiKey in .sitepilot-e2e.local.json.");
  assert(E2E_ADMIN_PASSWORD, "Sign-in needs the test site's admin password (SITEPILOT_E2E_ADMIN_PASSWORD).");

  const database = await createTestPostgresDatabase();
  const dataDirectory = mkdtempSync(join(tmpdir(), "sitepilot-hosted-e2e-"));
  const databaseUrl = new URL(database.url);
  const output: string[] = [];
  let server: ChildProcess | undefined;
  let callbackServer: Server | undefined;
  // A stand-in for Slack's Web API and response URLs: records what SitePilot sends.
  const slackCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const slackSigningSecret = randomBytes(16).toString("hex");
  let slackTs = 1_000;
  const slackApi = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const method = (request.url ?? "").replace(/^\/(?:api\/)?/, "");
      const form = (request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded");
      slackCalls.push({
        method,
        body: !text ? {} : form ? Object.fromEntries(new URLSearchParams(text)) : (JSON.parse(text) as Record<string, unknown>)
      });
      const extra =
        method === "auth.test" ? { user_id: "UBOT" } : method === "users.info" ? { user: { real_name: "E2E Slack person" } } : {};
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, ts: `${(slackTs += 1)}.000100`, ...extra }));
    });
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await new Promise<void>((resolve) => slackApi.listen(18997, "127.0.0.1", resolve));
    server = spawn(process.execPath, ["apps/server/dist/index.js"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        SITEPILOT_PUBLIC_URL: SERVER,
        SITEPILOT_SITE_URL: E2E_BASE_URL,
        SITEPILOT_DATA_DIR: dataDirectory,
        SITEPILOT_SECRETS_KEY: randomBytes(32).toString("base64"),
        DATABASE_URL: databaseUrl.toString(),
        OPENAI_API_KEY: E2E_OPENAI_API_KEY,
        SLACK_BOT_TOKEN: "xoxb-e2e",
        SLACK_SIGNING_SECRET: slackSigningSecret,
        SLACK_API_URL: "http://127.0.0.1:18997/api/",
        NODE_TLS_REJECT_UNAUTHORIZED: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    await waitFor(
      "the server",
      async () => (output.join("").includes("Serving the app") ? true : null),
      60_000
    );

    // 1. Connect the site. Only the configured one is accepted.
    const wrongSite = await fetch(`${SERVER}/sites/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: SERVER },
      body: new URLSearchParams({ siteUrl: "https://someone-else.example", registrationCode: "x", wordpressUsername: "x" })
    });
    assert(wrongSite.status === 400 && (await wrongSite.text()).includes("only manages"), "Another site could be connected.");
    const connected = await fetch(`${SERVER}/sites/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: SERVER },
      body: new URLSearchParams({
        siteUrl: E2E_BASE_URL,
        registrationCode: await currentRegistrationCode(),
        wordpressUsername: E2E_ADMIN_USERNAME
      })
    });
    const connectedPage = await connected.text();
    assert(connected.ok && connectedPage.includes("Site connected"), `Connecting failed: ${connectedPage.slice(0, 600)}`);
    const again = await fetch(`${SERVER}/sites/connect`, { headers: { origin: SERVER } });
    assert(again.status === 403, "A second site could be connected.");

    // 2. Sign in with WordPress.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${SERVER}/`);
    await page.getByRole("link", { name: "Sign in with WordPress" }).click();
    await page.waitForURL(/wp-login\.php/);
    await page.fill("#user_login", E2E_ADMIN_USERNAME);
    await page.fill("#user_pass", E2E_ADMIN_PASSWORD);
    await page.click("#wp-submit");
    await page.getByRole("button", { name: "Continue" }).click();
    // The app opens on the one connected site.
    await page.waitForURL(/#\/site\/[^/]+\/overview$/);
    const placeholder = page.getByPlaceholder(/Add Sunday hours/);
    await placeholder.waitFor();

    // The app's API: signed in, same origin, and no desktop-only calls.
    // No named functions in evaluate: tsx would wrap them in a helper the page lacks.
    const refusals = await page.evaluate(async (channels) =>
      Promise.all(
        channels.map(async (channel) =>
          (await fetch(`/api/ipc/${channel}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status
        )
      ),
      ["site.list", "site.register"]
    );
    assert(refusals[0] === 200 && refusals[1] === 404, `The app API answered ${JSON.stringify(refusals)}.`);
    const signedOut = await fetch(`${SERVER}/api/ipc/site.list`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: SERVER },
      body: "{}"
    });
    assert(signedOut.status === 401, "The app API answered without a session.");

    // 3. A personal MCP token, then the MCP server.
    await page.goto(`${SERVER}/account`);
    assert((await page.content()).includes("You can approve changes"), "The admin can't approve.");
    await page.fill("#label", "Hosted E2E");
    await page.getByRole("button", { name: "Create token" }).click();
    const token = (await page.locator("pre").filter({ hasText: /^spt_/ }).first().innerText()).trim();
    assert(/^spt_/.test(token), "No MCP token was shown.");
    const client = new Client({ name: "codex-hosted-e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    );
    const sites = await client.callTool({ name: "list_sites", arguments: {} });
    assert(!sites.isError && JSON.stringify(sites.content).includes(new URL(E2E_BASE_URL).hostname), "list_sites didn't return the site.");
    const lookup = await client.callTool({ name: "find_posts", arguments: { search: "Lake District", limit: 3 } });
    assert(!lookup.isError, `find_posts failed: ${JSON.stringify(lookup.content).slice(0, 300)}`);
    await client.close();
    const refused = await fetch(`${SERVER}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer spt_not_a_real_token_at_all_123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert(refused.status === 401, "An unknown MCP token wasn't refused.");

    // 3b. OAuth, as claude.ai connects.
    const unauthenticated = await fetch(`${SERVER}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    const challenge = unauthenticated.headers.get("www-authenticate") ?? "";
    const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    assert(unauthenticated.status === 401 && resourceMetadataUrl, `/mcp doesn't point to its OAuth metadata: ${challenge}`);
    const resourceMetadata = (await (await fetch(resourceMetadataUrl)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    assert(resourceMetadata.resource === `${SERVER}/mcp`, `Wrong protected resource: ${JSON.stringify(resourceMetadata)}`);
    const serverMetadata = (await (
      await fetch(new URL("/.well-known/oauth-authorization-server", resourceMetadata.authorization_servers[0]))
    ).json()) as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
    const callback = "http://127.0.0.1:18999/callback";
    const registration = await fetch(serverMetadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude E2E",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      })
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    assert(registration.status === 201 && clientId, `Registration failed (${registration.status}).`);
    const verifier = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(serverMetadata.authorization_endpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "e2e-state",
      scope: "read review",
      resource: `${SERVER}/mcp`
    }).toString();
    // The app's callback: the browser just has to arrive there.
    callbackServer = createServer((_request, response) => response.end("connected"));
    await new Promise<void>((resolve) => callbackServer!.listen(18999, "127.0.0.1", resolve));
    await page.goto(authorizeUrl.toString());
    assert((await page.content()).includes("Connect Claude E2E to SitePilot?"), "No consent page.");
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:18999\/callback/);
    const returned = new URL(page.url());
    const code = returned.searchParams.get("code") ?? "";
    assert(returned.searchParams.get("state") === "e2e-state" && code, `Bad callback: ${page.url()}`);
    const tokenRequest = (body: Record<string, string>) =>
      fetch(serverMetadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, ...body })
      });
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: `${SERVER}/mcp`
    });
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; scope: string };
    assert(exchanged.ok && /^spa_/.test(tokens.access_token) && tokens.scope === "read review", `Token exchange: ${JSON.stringify(tokens)}`);
    const replayed = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback });
    assert(replayed.status === 400, "An authorization code worked twice.");
    const oauthClient = new Client({ name: "claude-ai-e2e", version: "1.0.0" });
    await oauthClient.connect(
      new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }
      })
    );
    const oauthSites = await oauthClient.callTool({ name: "list_sites", arguments: {} });
    assert(!oauthSites.isError, `list_sites over OAuth failed: ${JSON.stringify(oauthSites.content).slice(0, 300)}`);
    const unscoped = await oauthClient.callTool({
      name: "create_request",
      arguments: { text: "Write a post.", target: { operation: "create_draft", post_type: "post" } }
    });
    assert(
      unscoped.isError && JSON.stringify(unscoped.structuredContent).includes("forbidden"),
      "create_request ran without the request scope."
    );
    await oauthClient.close();
    // Consent is remembered: connecting again goes straight back to the app.
    await page.goto(authorizeUrl.toString());
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:18999\/callback/);
    const refreshed = (await (await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json()) as {
      access_token: string;
    };
    assert(/^spa_/.test(refreshed.access_token ?? ""), "Refreshing didn't give a new access token.");
    await page.goto(`${SERVER}/account`);
    assert((await page.content()).includes("Claude E2E"), "The account page doesn't list the connected app.");
    await page.getByRole("button", { name: "Disconnect" }).first().click();
    await page.waitForURL(`${SERVER}/account`);
    const disconnected = await fetch(`${SERVER}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${refreshed.access_token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert(disconnected.status === 401, `A disconnected app's token still works (${disconnected.status}).`);

    // 4. A request in the app, approved and applied there.
    const title = `AUTOMATED-TEST-HOSTED-${randomUUID().slice(0, 8)}`;
    await page.goto(`${SERVER}/`);
    await placeholder.fill(`Create a short draft post titled "${title}" with one paragraph saying the hosted SitePilot test ran.`);
    await page.getByRole("button", { name: /Start request/ }).click();
    await page.waitForURL(/chat\?thread=/);
    await page.getByRole("button", { name: /^Send/ }).click();
    const requestUrl = page.url();
    const approve = page.getByRole("button", { name: "Approve this update" });
    await approve.waitFor({ timeout: 6 * 60_000 }).catch(async (error: unknown) => {
      throw new Error(`No preview to approve (${String(error)}):\n${(await page.locator("body").innerText()).slice(-1_500)}`);
    });
    // Typing "approved" approves nothing: it says to use the button.
    await page
      .getByPlaceholder(/Describe the change/)
      .fill("approved")
      .catch(async (error: unknown) => {
        throw new Error(`No reply box under the preview (${String(error)}):\n${(await page.locator("body").innerText()).slice(-1_500)}`);
      });
    await page.getByRole("button", { name: /Update request/ }).click();
    await page.getByText("Typing doesn't approve a change").first().waitFor({ timeout: 60_000 });
    assert(await approve.isEnabled(), "Typing \"approved\" changed the review.");
    await approve.click();
    await page.getByRole("button", { name: "Apply this update to the site" }).click();
    await page
      .getByText("Completed and verified")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 6 * 60_000 })
      .catch(async (error: unknown) => {
        throw new Error(`Applying didn't finish (${String(error)}):\n${(await page.locator("body").innerText()).slice(-1_500)}`);
      });
    // 4b. Approval from a chat app's own prompt, as Codex asks: a request over
    // MCP, a signed preview link, then the person's answer applies it.
    const promptTitle = `AUTOMATED-TEST-HOSTED-PROMPT-${randomUUID().slice(0, 8)}`;
    let prompted = "";
    const codex = new Client({ name: "codex", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    codex.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompted = request.params.message;
      return { action: "accept", content: { decision: "approve" } };
    });
    await codex.connect(
      new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    );
    const json = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      JSON.parse((result.content as Array<{ text: string }>).at(-1)?.text ?? "{}") as {
        requestId?: string;
        state?: string;
        reviewArtifacts?: Array<{ kind: string; url?: string }>;
      };
    const promptRequest = json(
      await codex.callTool({
        name: "create_request",
        arguments: {
          text: `Create a short draft post titled "${promptTitle}" with one sentence saying the chat approval test ran.`,
          target: { operation: "create_draft", post_type: "post" }
        }
      })
    );
    assert(promptRequest.requestId, "create_request gave no request ID.");
    const waiting = await waitFor(
      "the MCP request's preview",
      async () => {
        const status = json(await codex.callTool({ name: "request_status", arguments: { request_id: promptRequest.requestId } }));
        if (status.state === "needs_attention") throw new Error(`The MCP request needs attention: ${JSON.stringify(status)}`);
        return status.state === "awaiting_approval" ? status : null;
      },
      6 * 60_000
    );
    const previewLink = waiting.reviewArtifacts?.find((artifact) => artifact.kind === "preview")?.url ?? "";
    const preview = await fetch(previewLink);
    assert(
      preview.ok && (preview.headers.get("content-type") ?? "").startsWith("image/"),
      `The signed preview link didn't open without signing in (${preview.status} ${previewLink}).`
    );
    assert((await fetch(`${previewLink}x`)).status === 404, "An altered preview link worked.");
    const asked = await codex.callTool({ name: "ask_to_approve", arguments: { request_id: promptRequest.requestId } });
    assert(!asked.isError && prompted.includes(promptTitle), `ask_to_approve: ${JSON.stringify(asked.content).slice(0, 400)}`);
    await waitFor(
      "the prompt-approved change to be applied",
      async () => {
        const status = json(await codex.callTool({ name: "request_status", arguments: { request_id: promptRequest.requestId } }));
        if (status.state === "needs_attention") throw new Error(`Applying failed: ${JSON.stringify(status)}`);
        return status.state === "completed" ? true : null;
      },
      6 * 60_000
    );
    await codex.close();
    const promptPostId = E2E_WP_PATH
      ? execFileSync("wp", ["post", "list", "--post_type=post", "--post_status=draft", `--title=${promptTitle}`, "--field=ID"], {
          cwd: E2E_WP_PATH,
          encoding: "utf8"
        }).trim()
      : "(no wp-cli)";
    assert(promptPostId !== "", "The prompt-approved draft isn't in WordPress.");

    // 4c. Slack.
    const slackPost = (path: string, body: string, contentType: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return fetch(`${SERVER}${path}`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${createHmac("sha256", slackSigningSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`
        },
        body
      });
    };
    const slackEvent = (event: Record<string, unknown>) =>
      slackPost("/slack/events", JSON.stringify({ type: "event_callback", team_id: "T_E2E", event }), "application/json");
    const slackSent = (label: string, match: (call: { method: string; body: Record<string, unknown> }) => boolean, timeoutMs: number) =>
      waitFor(label, async () => slackCalls.find(match) ?? null, timeoutMs);
    const verification = (await (
      await fetch(`${SERVER}/slack/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "e2e-challenge" })
      })
    ).json()) as { challenge?: string };
    assert(verification.challenge === "e2e-challenge", "Slack's URL check wasn't answered.");
    const unsignedSlack = await fetch(`${SERVER}/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback", team_id: "T_E2E", event: { type: "app_mention", user: "U_E2E", text: "hi", channel: "C_E2E", ts: "1.1" } })
    });
    assert(unsignedSlack.status === 401, "An unsigned Slack event was accepted.");
    // Someone not yet connected gets a link only they can see.
    await slackEvent({ type: "app_mention", user: "U_E2E", text: "<@UBOT> hello", channel: "C_E2E", ts: "100.000001" });
    const connectPrompt = await slackSent("the connect link", (call) => call.method === "chat.postEphemeral" && call.body.user === "U_E2E", 30_000);
    const connectUrl = /"url":"([^"]+)"/.exec(JSON.stringify(connectPrompt.body.blocks))?.[1] ?? "";
    assert(connectUrl.startsWith(`${SERVER}/slack/connect?token=`), `No connect link: ${JSON.stringify(connectPrompt.body)}`);
    await page.goto(connectUrl);
    assert((await page.content()).includes("Connect Slack to SitePilot?"), "No Slack connect page.");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Go back to Slack").waitFor();
    // A question is answered in its thread, read-only; a reply asks again.
    const answeredIn = (threadTs: string, after = 0) =>
      slackSent(
        `an answer in thread ${threadTs}`,
        (call) =>
          slackCalls.indexOf(call) >= after &&
          call.method === "chat.postMessage" &&
          call.body.thread_ts === threadTs &&
          JSON.stringify(call.body.blocks ?? []).includes('"type":"section"') &&
          !String(call.body.text).startsWith("SitePilot couldn't"),
        90_000
      );
    await slackEvent({ type: "app_mention", user: "U_E2E", text: "<@UBOT> what is the latest post?", channel: "C_E2E", ts: "150.000001" });
    const firstAnswer = await answeredIn("150.000001");
    assert(JSON.stringify(firstAnswer.body.blocks).includes("Reply here to ask more"), "A question wasn't answered as a conversation.");
    assert(
      !slackCalls.some((call) => call.body.thread_ts === "150.000001" && String(call.body.text).startsWith("On it")),
      "A question started a request."
    );
    const beforeFollowUp = slackCalls.length;
    await slackEvent({
      type: "message",
      channel_type: "channel",
      user: "U_E2E",
      text: "and how many pages are there?",
      channel: "C_E2E",
      ts: "150.000300",
      thread_ts: "150.000001"
    });
    await answeredIn("150.000001", beforeFollowUp);
    // When the wording doesn't say, SitePilot asks, and the button decides.
    await slackEvent({ type: "app_mention", user: "U_E2E", text: "<@UBOT> the intro is too long", channel: "C_E2E", ts: "160.000001" });
    const which = await slackSent(
      "the question-or-change buttons",
      (call) => call.method === "chat.postMessage" && call.body.thread_ts === "160.000001" && JSON.stringify(call.body.blocks ?? []).includes('"action_id":"route_ask"'),
      30_000
    );
    const whichBlocks = which.body.blocks as Array<{ type: string; elements?: Array<{ action_id?: string; value?: string }> }>;
    const askValue = whichBlocks.find((block) => block.type === "actions")?.elements?.find((button) => button.action_id === "route_ask")?.value ?? "";
    const beforeChoice = slackCalls.length;
    await slackPost(
      "/slack/interactions",
      new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_E2E" },
          user: { id: "U_E2E" },
          channel: { id: "C_E2E" },
          message: { ts: "9999.000003", thread_ts: "160.000001", blocks: whichBlocks },
          response_url: "http://127.0.0.1:18997/response/route",
          actions: [{ action_id: "route_ask", value: askValue }]
        })
      }).toString(),
      "application/x-www-form-urlencoded"
    );
    await slackSent("the settled choice", (call) => call.method === "response/route" && String(call.body.text).includes("asked for an answer"), 30_000);
    await answeredIn("160.000001", beforeChoice);

    // A request in a thread: its review, with previews and buttons.
    const slackTitle = `AUTOMATED-TEST-HOSTED-SLACK-${randomUUID().slice(0, 8)}`;
    await slackEvent({
      type: "app_mention",
      user: "U_E2E",
      text: `<@UBOT> Create a short draft post titled "${slackTitle}" with one sentence saying the Slack test ran.`,
      channel: "C_E2E",
      ts: "200.000001"
    });
    await slackSent(
      "SitePilot's reply in the thread",
      (call) => call.method === "chat.postMessage" && call.body.thread_ts === "200.000001" && String(call.body.text).startsWith("On it"),
      30_000
    );
    const slackReview = await slackSent(
      "the review in Slack",
      (call) =>
        call.method === "chat.postMessage" &&
        call.body.thread_ts === "200.000001" &&
        JSON.stringify(call.body.blocks ?? []).includes('"action_id":"approve"'),
      6 * 60_000
    );
    const reviewBlocks = slackReview.body.blocks as Array<{ type: string; image_url?: string; elements?: Array<{ action_id?: string; value?: string }> }>;
    const slackImage = reviewBlocks.find((block) => block.type === "image")?.image_url ?? "";
    assert((await fetch(slackImage)).ok, `Slack's preview image didn't load: ${slackImage}`);
    // Typing "approved" in the thread does nothing.
    await slackEvent({
      type: "message",
      channel_type: "channel",
      user: "U_E2E",
      text: "approved",
      channel: "C_E2E",
      ts: "200.000500",
      thread_ts: "200.000001"
    });
    await slackSent(
      "the typed-approval reply",
      (call) => call.method === "chat.postMessage" && String(call.body.text).startsWith("Typing doesn't approve"),
      30_000
    );
    // Clicking Approve applies it.
    const approveValue = reviewBlocks.find((block) => block.type === "actions")?.elements?.find((button) => button.action_id === "approve")?.value;
    await slackPost(
      "/slack/interactions",
      new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T_E2E" },
          user: { id: "U_E2E" },
          channel: { id: "C_E2E" },
          message: { ts: "9999.000001", thread_ts: "200.000001", blocks: reviewBlocks },
          response_url: "http://127.0.0.1:18997/response/approve",
          actions: [{ action_id: "approve", value: approveValue }]
        })
      }).toString(),
      "application/x-www-form-urlencoded"
    );
    await slackSent("the approved review", (call) => call.method === "response/approve" && String(call.body.text).startsWith("Approved by"), 60_000);
    const slackDone = await slackSent(
      "Done in Slack",
      (call) => call.method === "chat.postMessage" && call.body.thread_ts === "200.000001" && String(call.body.text).startsWith("Done."),
      6 * 60_000
    );
    // Publish it, in the same SitePilot request: its own review, approved the same way.
    const doneBlocks = slackDone.body.blocks as Array<{ type: string; elements?: Array<{ action_id?: string; value?: string }> }>;
    const publishValue = doneBlocks.find((block) => block.type === "actions")?.elements?.find((button) => button.action_id === "publish")?.value;
    assert(publishValue, `The Done message has no Publish button: ${JSON.stringify(slackDone.body)}`);
    const reviewsBefore = slackCalls.filter((call) => JSON.stringify(call.body.blocks ?? []).includes('"action_id":"approve"')).length;
    const click = (action: string, value: string, blocks: unknown, responsePath: string) =>
      slackPost(
        "/slack/interactions",
        new URLSearchParams({
          payload: JSON.stringify({
            type: "block_actions",
            team: { id: "T_E2E" },
            user: { id: "U_E2E" },
            channel: { id: "C_E2E" },
            message: { ts: "9999.000002", thread_ts: "200.000001", blocks },
            response_url: `http://127.0.0.1:18997/response/${responsePath}`,
            actions: [{ action_id: action, value }]
          })
        }).toString(),
        "application/x-www-form-urlencoded"
      );
    await click("publish", publishValue, doneBlocks, "publish");
    await slackSent("the publish request", (call) => call.method === "response/publish" && String(call.body.text).startsWith("Publishing requested"), 60_000);
    const publishReview = await waitFor(
      "the publish review",
      async () =>
        slackCalls.filter((call) => call.body.thread_ts === "200.000001" && JSON.stringify(call.body.blocks ?? []).includes('"action_id":"approve"'))[
          reviewsBefore
        ] ?? null,
      6 * 60_000
    );
    const publishBlocks = publishReview.body.blocks as typeof reviewBlocks;
    const approvePublish = publishBlocks.find((block) => block.type === "actions")?.elements?.find((button) => button.action_id === "approve")?.value ?? "";
    await click("approve", approvePublish, publishBlocks, "approve-publish");
    await slackSent(
      "Published in Slack",
      (call) =>
        call.method === "chat.postMessage" &&
        call.body.thread_ts === "200.000001" &&
        JSON.stringify(call.body.blocks ?? []).includes("Published. Written to the site and verified."),
      6 * 60_000
    );
    const slackPostId = E2E_WP_PATH
      ? execFileSync("wp", ["post", "list", "--post_type=post", "--post_status=publish", `--title=${slackTitle}`, "--field=ID"], {
          cwd: E2E_WP_PATH,
          encoding: "utf8"
        }).trim()
      : "(no wp-cli)";
    assert(slackPostId !== "", "The Slack-approved post isn't published in WordPress.");

    // 5. A contributor can request but not approve, apply or change setup.
    // (Editors and authors can publish, so they approve.)
    if (E2E_WP_PATH) {
      const requester = "sitepilot-e2e-contributor";
      const requesterPassword = randomBytes(18).toString("base64url");
      const wp = (...args: string[]) =>
        execFileSync("wp", args, { cwd: E2E_WP_PATH, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      let requesterExists = true;
      try {
        wp("user", "get", requester, "--field=ID");
      } catch {
        requesterExists = false;
      }
      if (requesterExists) wp("user", "update", requester, `--user_pass=${requesterPassword}`, "--role=contributor", "--skip-email");
      else wp("user", "create", requester, "sitepilot-e2e-contributor@example.test", "--role=contributor", `--user_pass=${requesterPassword}`);
      const requesterContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const requesterPage = await requesterContext.newPage();
      await requesterPage.goto(`${SERVER}/auth/wordpress/start`);
      await requesterPage.waitForURL(/wp-login\.php/);
      await requesterPage.fill("#user_login", requester);
      await requesterPage.fill("#user_pass", requesterPassword);
      await requesterPage.click("#wp-submit");
      await requesterPage.getByRole("button", { name: "Continue" }).click();
      await requesterPage.waitForURL(/#\/site\/[^/]+\/overview$/);
      const siteId = /#\/site\/([^/]+)\//.exec(requesterPage.url())?.[1] ?? "";
      const answers = await requesterPage.evaluate(
        async (calls) =>
          Promise.all(
            calls.map(async ([channel, body]) => {
              const response = await fetch(`/api/ipc/${channel}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
              });
              return `${response.status} ${((await response.json()) as { code?: string }).code ?? "ok"}`;
            })
          ),
        [
          ["gutenbergV2.decideCandidate", { siteId, requestId: "r", candidateId: "c", decision: "approved" }],
          ["gutenbergV2.executeCandidate", { siteId, requestId: "r" }],
          ["site.confirmConfig", { siteId }],
          ["site.list", {}]
        ] as Array<[string, Record<string, string>]>
      );
      assert(
        JSON.stringify(answers) === JSON.stringify(["200 forbidden", "200 forbidden", "403 forbidden", "200 ok"]),
        `A contributor's calls answered ${JSON.stringify(answers)}.`
      );
      await requesterPage.goto(`${SERVER}/account`);
      assert((await requesterPage.content()).includes("someone who can publish approves them"), "The contributor isn't a requester.");

      // 5b. The admin area: only admins open it, and a role set there applies at once.
      const adminArea = await requesterPage.goto(`${SERVER}/admin/people`);
      assert(adminArea?.status() === 403, `A contributor opened the admin area (${adminArea?.status()}).`);
      const requesterId = wp("user", "get", requester, "--field=ID");
      await page.goto(`${SERVER}/admin/people`);
      const requesterCard = page.locator(`#person-${requesterId}`);
      assert((await requesterCard.innerText()).includes("WordPress role: Requester"), "The admin area doesn't list the contributor.");
      const submitted = (button: ReturnType<typeof page.getByRole>) =>
        Promise.all([
          page.waitForResponse((response) => response.url() === `${SERVER}/admin/people` && response.request().method() === "GET"),
          button.click()
        ]);
      const setRole = async (role: string) => {
        await requesterCard.locator("select[name=role]").selectOption(role);
        await submitted(requesterCard.getByRole("button", { name: "Save role" }));
      };
      await setRole("approver");
      await requesterPage.goto(`${SERVER}/account`);
      const promoted = await requesterPage.content();
      assert(promoted.includes("You can approve changes") && promoted.includes("set by a site admin"), "The approver role didn't apply.");
      await setRole("none");
      await requesterPage.goto(`${SERVER}/account`);
      assert(
        requesterPage.url() === `${SERVER}/` && (await requesterPage.content()).includes("Sign in with WordPress"),
        `No access still let the contributor in (${requesterPage.url()}).`
      );
      await setRole("wordpress");
      await requesterPage.goto(`${SERVER}/account`);
      assert((await requesterPage.content()).includes("someone who can publish approves them"), "The contributor's WordPress role didn't come back.");
      await requesterContext.close();
      // Revoking a token there stops it at once.
      const adminId = wp("user", "get", E2E_ADMIN_USERNAME, "--field=ID");
      await submitted(page.locator(`#person-${adminId} li`, { hasText: "Hosted E2E" }).getByRole("button", { name: "Revoke" }));
      const revoked = await fetch(`${SERVER}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      assert(revoked.status === 401, `A token revoked in the admin area still works (${revoked.status}).`);
    }

    const postId = E2E_WP_PATH
      ? execFileSync("wp", ["post", "list", "--post_type=post", "--post_status=draft", `--title=${title}`, "--field=ID"], {
          cwd: E2E_WP_PATH,
          encoding: "utf8"
        }).trim()
      : "(no wp-cli)";
    assert(postId !== "", "The approved draft isn't in WordPress.");
    console.log("Hosted E2E passed.");
    console.log(
      JSON.stringify(
        {
          request: requestUrl,
          title,
          postId,
          promptPostId,
          slackPostId,
          manualCleanup: `Delete drafts ${postId} and ${promptPostId}, and published post ${slackPostId}, from the MAMP site.`
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(output.join("").slice(-4_000));
    throw error;
  } finally {
    await browser.close();
    callbackServer?.close();
    slackApi.close();
    server?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await database.drop().catch(() => undefined);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
