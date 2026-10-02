/**
 * The local SitePilot MCP server end to end, against the MAMP site.
 *
 * 1. Starts the desktop MCP backend on a localhost port, as the desktop does.
 * 2. Connects as Codex over Streamable HTTP with the bearer token.
 * 3. Runs a real lookup and a Conversation.
 * 4. Creates a request and polls request_status to awaiting_approval.
 * 5. Fetches a review screenshot.
 * 6. Approves and applies through the desktop service, as a person would.
 *    Confirms the same calls are refused from the MCP client's context.
 * 7. Polls request_status to completed and checks thread sources and audit.
 *
 * Needs the same MAMP environment as `npm run test:e2e:v2-chat`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestId, SiteId } from "@sitepilot/domain";
import {
  createSitePilotMcpServer,
  startLocalMcpHttpServer,
  type McpRequestStatus
} from "@sitepilot/mcp-server";
import { initializeDatabase } from "@sitepilot/repositories";

import { getDatabase } from "../../packages/core/src/app-database.js";
import {
  DEFAULT_OPERATOR,
  runWithCallContext
} from "../../packages/core/src/call-context.js";
import {
  configureGutenbergV2PlannerFactory,
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  getGutenbergV2RequestState
} from "../../packages/core/src/gutenberg-v2-chat-service.js";
import { createDesktopMcpBackend } from "../../packages/core/src/mcp-backend.js";
import { registerSiteWithWordPress } from "../../packages/core/src/register-site.js";
import {
  configureRuntimeContext,
  resetRuntimeContext
} from "../../packages/core/src/runtime-context.js";

import {
  E2E_ADMIN_USERNAME,
  E2E_BASE_URL
} from "./config.js";
import { currentRegistrationCode } from "./registration.js";
import { createFileSecureStorage } from "./file-secure-storage.js";

const EXACT_TEST_URL = "https://test.localhost:8890/";
const TOKEN = "spmcp_e2e-token";
const POLL_MS = 1_000;
const POLL_LIMIT_MS = 180_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deterministicPlanner(title: string): void {
  configureGutenbergV2PlannerFactory(async () => ({
    ok: true as const,
    model: "sitepilot-mcp-e2e",
    client: {
      providerId: "sitepilot-mcp-e2e",
      complete: async () => ({
        text: JSON.stringify({
          postFields: { title },
          blocks: [
            {
              ref: "intro",
              name: "core/paragraph",
              attributes: {
                content: "Drafted through the SitePilot MCP server."
              },
              children: []
            }
          ]
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
      })
    }
  }));
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** The last text block is the JSON payload; a preface may come first. */
function jsonOf<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert(!result.isError, `Tool failed: ${textOf(result)}`);
  const parts = (
    result.content as Array<{ type: string; text?: string }>
  ).filter((part) => part.type === "text");
  return JSON.parse(parts.at(-1)?.text ?? "null") as T;
}

async function pollStatus(
  client: Client,
  requestId: string,
  until: (status: McpRequestStatus) => boolean
): Promise<McpRequestStatus> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  let status: McpRequestStatus | null = null;
  while (Date.now() < deadline) {
    status = jsonOf<McpRequestStatus>(
      await client.callTool({
        name: "request_status",
        arguments: { request_id: requestId }
      })
    );
    if (until(status)) return status;
    if (status.state === "needs_attention") {
      throw new Error(`Request needs attention: ${status.summary}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `Request did not reach the expected state; last was ${status?.state ?? "unknown"}.`
  );
}

async function main(): Promise<void> {
  assert(
    E2E_BASE_URL === EXACT_TEST_URL,
    `Refusing MCP E2E against ${E2E_BASE_URL}. Expected exactly ${EXACT_TEST_URL}`
  );
  const runtimeDir = mkdtempSync(join(tmpdir(), "sitepilot-mcp-e2e-"));
  const secureStorage = createFileSecureStorage(
    join(runtimeDir, "secure-store")
  );
  const database = initializeDatabase({
    filePath: join(runtimeDir, "sitepilot.sqlite")
  });
  configureRuntimeContext({
    userDataPath: runtimeDir,
    database,
    secureStorage
  });

  let siteId: SiteId | undefined;
  let postId: number | undefined;
  let closeHost: (() => Promise<void>) | undefined;
  let client: Client | undefined;
  const backend = createDesktopMcpBackend({ siteScope: "all" });

  try {
    getDatabase();
    const registration = await registerSiteWithWordPress({
      baseUrl: E2E_BASE_URL,
      siteName: "SitePilot MCP E2E",
      wordpressUsername: E2E_ADMIN_USERNAME,
      workspaceId: "workspace-1",
      environment: "development",
      registrationCode: await currentRegistrationCode()
    });
    if (!("site" in registration)) {
      throw new Error(
        `MAMP registration failed (${"code" in registration ? `${registration.code}: ${registration.message}` : "missing site"}).`
      );
    }
    siteId = registration.site.id as SiteId;
    const site = await database.repositories.sites.getById(siteId);
    assert(site, "Registration did not persist the site.");
    await database.repositories.sites.save({
      ...site,
      activationStatus: "active",
      updatedAt: new Date().toISOString()
    });

    const host = await startLocalMcpHttpServer({
      port: 0,
      token: TOKEN,
      createServer: () => createSitePilotMcpServer({ backend, version: "e2e" })
    });
    closeHost = host.close;

    client = new Client({ name: "codex-mcp-client", version: "e2e" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
      })
    );

    // Lookups hit the real plugin through the read-only registry.
    const sites = jsonOf<{ sites: Array<{ siteId: string }> }>(
      await client.callTool({ name: "list_sites", arguments: {} })
    );
    assert(
      sites.sites.some((entry) => entry.siteId === siteId),
      "list_sites did not include the registered site."
    );
    const found = jsonOf<{ matches?: unknown[] }>(
      await client.callTool({
        name: "find_posts",
        arguments: { site_id: siteId, limit: 3, orderby: "date" }
      })
    );
    assert(
      Array.isArray(found.matches),
      "find_posts returned no matches list."
    );
    // Categories and tags: the site always has its default category.
    const categories = jsonOf<{ terms?: Array<{ term_id: number; slug: string; count: number }> }>(
      await client.callTool({ name: "list_terms", arguments: { site_id: siteId } })
    );
    assert(
      Array.isArray(categories.terms) && categories.terms.length > 0 && typeof categories.terms[0]?.slug === "string",
      `list_terms returned no categories: ${JSON.stringify(categories).slice(0, 300)}`
    );
    const tagged = jsonOf<{ matches?: unknown[] }>(
      await client.callTool({ name: "find_posts", arguments: { site_id: siteId, tag: "no-such-tag-e2e" } })
    );
    assert(Array.isArray(tagged.matches) && tagged.matches.length === 0, "find_posts ignored the tag filter.");
    const menus = await client.callTool({ name: "list_terms", arguments: { site_id: siteId, taxonomy: "nav_menu" } });
    assert(menus.isError === true && textOf(menus).includes("invalid_taxonomy"), "list_terms listed a private taxonomy.");

    const conversation = jsonOf<{ thread_id: string; answer: string }>(
      await client.callTool({
        name: "create_conversation",
        arguments: { site_id: siteId, question: "What are the latest posts?" }
      })
    );
    assert(
      conversation.thread_id && conversation.answer.length > 0,
      "create_conversation did not answer."
    );

    // Hardening T4: a pasted link can't make SitePilot read this machine or
    // the local network, even through a Conversation started from MCP.
    const local = jsonOf<{ thread_id: string; answer: string }>(
      await client.callTool({
        name: "create_conversation",
        arguments: {
          site_id: siteId,
          question: "Summarise the text on this page: http://127.0.0.1:8765/"
        }
      })
    );
    assert(
      /private or local address/i.test(local.answer),
      `A loopback link was not refused: ${local.answer.slice(0, 300)}`
    );

    // A request returns straight away and builds its preview in the background.
    const title = `SitePilot MCP E2E ${Date.now()}`;
    deterministicPlanner(title);
    const created = jsonOf<McpRequestStatus>(
      await client.callTool({
        name: "create_request",
        arguments: {
          site_id: siteId,
          text: "Create a deterministic Gutenberg v2 draft for the MCP harness.",
          target: { operation: "create_draft", post_type: "post" }
        }
      })
    );
    assert(
      created.state === "preparing_preview",
      `create_request started in ${created.state}.`
    );
    const requestThreadId = created.requestId;

    const ready = await pollStatus(
      client,
      requestThreadId,
      (status) => status.state === "awaiting_approval"
    );
    assert(
      ready.changes?.title === title,
      "The status did not show the title."
    );
    assert(ready.approvalHint, "The status did not say where to approve.");

    const preview = ready.reviewArtifacts?.find((a) => a.kind === "preview");
    if (preview) {
      const image = await client.callTool({
        name: "get_review_artifact",
        arguments: { request_id: requestThreadId, artifact_id: preview.id }
      });
      const part = (
        image.content as Array<{ type: string; mimeType?: string }>
      )[0];
      assert(
        part?.type === "image" && part.mimeType === "image/png",
        "The review preview did not come back as a PNG image."
      );
    }

    // No tool approves. The same service calls are refused from the MCP
    // client's context and allowed from the desktop's.
    const requests = await database.repositories.requests.listByThreadId(
      requestThreadId as never
    );
    const requestId = requests.at(-1)?.id as RequestId;
    const v2 = await getGutenbergV2RequestState({ siteId, requestId });
    assert(v2.ok && v2.state?.candidate, "No candidate to approve.");
    const refused = await runWithCallContext(
      {
        actor: { ...DEFAULT_OPERATOR, siteRoles: ["request"] },
        source: "codex"
      },
      () =>
        decideGutenbergV2Candidate({
          siteId: siteId as SiteId,
          requestId,
          candidateId: v2.state!.candidate!.candidateId,
          decision: "approved"
        })
    );
    assert(
      "code" in refused && refused.code === "forbidden",
      "An MCP client context was allowed to approve."
    );

    const approved = await decideGutenbergV2Candidate({
      siteId,
      requestId,
      candidateId: v2.state.candidate.candidateId,
      decision: "approved"
    });
    assert(approved.ok, "The desktop approval failed.");
    const executed = await executeGutenbergV2Candidate({ siteId, requestId });
    assert(
      "state" in executed && executed.state.state === "succeeded",
      "Execution did not succeed."
    );

    const done = await pollStatus(
      client,
      requestThreadId,
      (status) => status.state === "completed"
    );
    postId = done.result?.postId;
    assert(
      postId !== undefined,
      "The completed status did not give the post ID."
    );

    const threads = jsonOf<{
      threads: Array<{ threadId: string; source?: string; kind: string }>;
    }>(
      await client.callTool({
        name: "list_threads",
        arguments: { site_id: siteId, source: "codex" }
      })
    );
    const ids = threads.threads.map((thread) => thread.threadId);
    assert(
      ids.includes(requestThreadId) && ids.includes(conversation.thread_id),
      "list_threads did not show both threads as started from Codex."
    );

    const audited = database.connection
      .prepare<{ siteId: string }, { c: number }>(
        `SELECT COUNT(*) AS c FROM audit_entries
          WHERE site_id = @siteId AND event_type = 'mcp_tool_called'
            AND json_extract(metadata_json, '$.source') = 'codex'`
      )
      .get({ siteId });
    assert((audited?.c ?? 0) >= 5, "MCP tool calls were not audited.");

    const requestActor = database.connection
      .prepare<
        { threadId: string },
        { json: string }
      >(`SELECT requested_by_json AS json FROM requests WHERE thread_id = @threadId`)
      .get({ threadId: requestThreadId });
    assert(
      (JSON.parse(requestActor?.json ?? "{}") as { source?: string }).source ===
        "codex",
      "The request did not record Codex as its source."
    );

    console.log("MCP E2E passed.");
  } finally {
    await client?.close().catch(() => undefined);
    await closeHost?.().catch(() => undefined);
    await backend.idle();
    configureGutenbergV2PlannerFactory(undefined);
    resetRuntimeContext();
    database.close();
    rmSync(runtimeDir, { recursive: true, force: true });
    console.log(
      JSON.stringify(
        {
          siteId,
          postId,
          manualCleanup: postId
            ? `Delete draft post ${postId} from the managed MAMP site after review.`
            : "No draft post was created."
        },
        null,
        2
      )
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "MCP E2E failed.");
  process.exitCode = 1;
});
