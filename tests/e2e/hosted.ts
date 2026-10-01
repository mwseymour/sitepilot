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
 * 5. Sign in as a WordPress contributor (can edit, can't publish): a
 *    requester, refused approving and site setup. (Needs wp-cli, for the
 *    test user's password.)
 *
 * Needs SITEPILOT_TEST_POSTGRES_URL (the local Docker Postgres), an OpenAI
 * key for the planner, and SITEPILOT_E2E_WP_PATH for fresh registration codes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  const browser = await chromium.launch({ headless: true });
  try {
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
      await requesterContext.close();
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
      JSON.stringify({ request: requestUrl, title, postId, manualCleanup: `Delete draft ${postId} from the MAMP site.` }, null, 2)
    );
  } catch (error) {
    console.error(output.join("").slice(-4_000));
    throw error;
  } finally {
    await browser.close();
    callbackServer?.close();
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
