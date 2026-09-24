import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

import {
  gutenbergV2GetReviewArtifactResponseSchema,
  gutenbergV2RequestStateSchema
} from "@sitepilot/contracts";
import type { RequestId, SiteId } from "@sitepilot/domain";
import { initializeDatabase } from "@sitepilot/repositories";

import {
  createChatThreadForSite,
  createTypedRequestForThread
} from "../../apps/desktop/src/main/chat-service.js";
import {
  configureGutenbergV2PlannerFactory,
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  generateGutenbergV2Candidate,
  getGutenbergV2ReviewArtifact,
  hasGutenbergV2RequestMapping
} from "../../apps/desktop/src/main/gutenberg-v2-chat-service.js";
import { getDatabase } from "../../apps/desktop/src/main/app-database.js";
import { registerSiteWithWordPress } from "../../apps/desktop/src/main/register-site.js";
import {
  configureRuntimeContext,
  resetRuntimeContext
} from "../../apps/desktop/src/main/runtime-context.js";
import { saveSitePlannerSettings } from "../../apps/desktop/src/main/settings-service.js";
import { generateActionPlanForRequest } from "../../apps/desktop/src/main/plan-generation-service.js";
import { fetchSiteUrl } from "../../apps/desktop/src/main/site-fetch.js";

import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_BASE_URL,
  E2E_REGISTRATION_CODE
} from "./config.js";
import { createFileSecureStorage } from "./file-secure-storage.js";

const EXACT_TEST_URL = "https://test.localhost:8890/";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type ArtifactSummary = {
  id: string;
  kind: string;
  mimeType: string;
  bytes: number;
};

function deterministicPlanner(title: string): void {
  configureGutenbergV2PlannerFactory(async () => ({
    ok: true as const,
    model: "sitepilot-v2-chat-e2e",
    client: {
      providerId: "sitepilot-v2-chat-e2e",
      complete: async () => ({
        text: JSON.stringify({
          postFields: { title },
          blocks: [
            {
              ref: "intro",
              name: "core/paragraph",
              attributes: {
                content: "Deterministic Gutenberg v2 desktop boundary fixture."
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

async function discoverRegistrationCode(): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(`${E2E_BASE_URL}wp-login.php`, {
      waitUntil: "networkidle"
    });
    await page.locator("#user_login").fill(E2E_ADMIN_USERNAME);
    await page.locator("#user_pass").fill(E2E_ADMIN_PASSWORD);
    await page.locator("#wp-submit").click();
    await page.waitForURL(/wp-admin/, { timeout: 30_000 });
    await page.goto(
      `${E2E_BASE_URL}wp-admin/options-general.php?page=sitepilot`,
      { waitUntil: "networkidle" }
    );
    const code = (await page.locator("code").allTextContents())
      .map((value) => value.trim())
      .find((value) => /^[A-Za-z0-9]{16,}$/.test(value));
    if (!code) {
      throw new Error(
        "Could not discover the SitePilot registration code from wp-admin."
      );
    }
    return code;
  } finally {
    await browser.close();
  }
}

async function registerManagedSite(): Promise<
  Awaited<ReturnType<typeof registerSiteWithWordPress>>
> {
  const request = {
    baseUrl: E2E_BASE_URL,
    siteName: "SitePilot v2 Chat E2E",
    wordpressUsername: E2E_ADMIN_USERNAME,
    workspaceId: "workspace-1",
    environment: "development" as const
  };
  const configuredAttempt = await registerSiteWithWordPress({
    ...request,
    registrationCode: E2E_REGISTRATION_CODE
  });
  if (!("code" in configuredAttempt)) {
    return configuredAttempt;
  }
  if (
    configuredAttempt.code !== "register_rejected" ||
    !/invalid registration code/i.test(configuredAttempt.message)
  ) {
    return configuredAttempt;
  }
  return registerSiteWithWordPress({
    ...request,
    registrationCode: await discoverRegistrationCode()
  });
}

function summarizeArtifact(
  artifact: Extract<
    ReturnType<typeof gutenbergV2GetReviewArtifactResponseSchema.parse>,
    { ok: true }
  >["artifact"]
): ArtifactSummary {
  assert(
    /^[A-Za-z0-9+/]+={0,2}$/.test(artifact.dataBase64),
    `Review artifact ${artifact.id} is not valid base64.`
  );
  const bytes = Buffer.from(artifact.dataBase64, "base64");
  assert(bytes.byteLength > 0, `Review artifact ${artifact.id} is empty.`);
  if (artifact.kind === "structure_diff") {
    assert(
      artifact.mimeType === "application/json",
      `Structure artifact ${artifact.id} has MIME type ${artifact.mimeType}.`
    );
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Structure artifact ${artifact.id} is not valid JSON.`);
    }
  } else {
    assert(
      artifact.mimeType === "image/png",
      `Preview artifact ${artifact.id} has MIME type ${artifact.mimeType}.`
    );
    assert(
      bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
      `Preview artifact ${artifact.id} is not a PNG.`
    );
  }
  return {
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    bytes: bytes.byteLength
  };
}

async function main(): Promise<void> {
  assert(
    E2E_BASE_URL === EXACT_TEST_URL,
    `Refusing v2 chat E2E against ${E2E_BASE_URL}. Expected exactly ${EXACT_TEST_URL}`
  );
  const runtimeDir = mkdtempSync(join(tmpdir(), "sitepilot-v2-chat-e2e-"));
  const secureStorage = createFileSecureStorage(
    join(runtimeDir, "secure-store")
  );
  const database = initializeDatabase({
    filePath: join(runtimeDir, "sitepilot.sqlite")
  });
  let postId: number | undefined;
  let siteId: SiteId | undefined;
  let requestId: RequestId | undefined;
  const artifactSummary: ArtifactSummary[] = [];

  configureRuntimeContext({
    userDataPath: runtimeDir,
    database,
    secureStorage
  });

  try {
    // Seed the normal desktop workspace before registration writes its site rows.
    getDatabase();
    const workspace = database.connection
      .prepare<
        [{ workspaceId: string }],
        { id: string }
      >("SELECT id FROM workspaces WHERE id = @workspaceId")
      .get({ workspaceId: "workspace-1" });
    const owner = database.connection
      .prepare<
        [{ workspaceId: string }],
        { id: string }
      >("SELECT id FROM user_profiles WHERE workspace_id = @workspaceId AND app_role = 'owner' LIMIT 1")
      .get({ workspaceId: "workspace-1" });
    assert(workspace, "Desktop registration workspace was not seeded.");
    assert(owner, "Desktop registration owner profile was not seeded.");

    const registration = await registerManagedSite();
    if (!("site" in registration)) {
      throw new Error(
        `MAMP registration failed (${"code" in registration ? registration.code : "missing site"}).`
      );
    }
    siteId = registration.site.id as SiteId;

    const registeredSite = await database.repositories.sites.getById(siteId);
    assert(registeredSite, "Registration did not persist the site.");
    await database.repositories.sites.save({
      ...registeredSite,
      activationStatus: "active",
      updatedAt: new Date().toISOString()
    });

    // Prove the local half of the double gate blocks before planner execution.
    await saveSitePlannerSettings(secureStorage, siteId, {
      bypassApprovalRequests: false,
      gutenbergV2Enabled: false
    });
    const thread = await createChatThreadForSite(siteId, {
      title: "Gutenberg v2 Chat E2E",
      type: "general_request"
    });
    if (!("thread" in thread)) {
      throw new Error(
        `Thread creation failed (${"code" in thread ? thread.code : "missing thread"}).`
      );
    }
    const request = await createTypedRequestForThread(
      siteId,
      thread.thread.id,
      "Create a deterministic Gutenberg v2 draft for the desktop boundary harness."
    );
    if (!("request" in request)) {
      throw new Error(
        `Request creation failed (${"code" in request ? request.code : "missing request"}).`
      );
    }
    requestId = request.request.id;

    const target = {
      operation: "create_draft" as const,
      postType: "post" as const
    };
    const disabled = await generateGutenbergV2Candidate({
      siteId,
      requestId,
      target
    });
    assert(
      "code" in disabled && disabled.code === "gutenberg_v2_not_enabled",
      "The local Gutenberg v2 gate did not block generation."
    );

    await saveSitePlannerSettings(secureStorage, siteId, {
      bypassApprovalRequests: false,
      gutenbergV2Enabled: true
    });
    const protocolResponse = await fetchSiteUrl(
      `${E2E_BASE_URL.replace(/\/+$/, "")}/wp-json/sitepilot/v1/protocol`
    );
    const protocolBody = (await protocolResponse.json()) as {
      v2?: { enabled?: unknown };
    };
    assert(
      protocolResponse.ok && protocolBody.v2?.enabled === true,
      "The MAMP destination Gutenberg v2 gate is disabled."
    );
    deterministicPlanner(`SitePilot v2 Chat E2E ${requestId}`);

    const generated = await generateGutenbergV2Candidate({
      siteId,
      requestId,
      target
    });
    if (!("state" in generated)) {
      throw new Error(
        `Candidate generation failed (${"code" in generated ? generated.code : "missing state"}).`
      );
    }
    const generatedState = gutenbergV2RequestStateSchema.parse(generated.state);
    assert(generatedState.candidate, "Generation did not return a candidate.");
    const candidateId = generatedState.candidate.candidateId;

    for (const reference of generatedState.candidate.reviewArtifacts) {
      const artifact = await getGutenbergV2ReviewArtifact({
        siteId,
        requestId,
        artifactId: reference.id
      });
      const parsed = gutenbergV2GetReviewArtifactResponseSchema.parse(artifact);
      assert(parsed.ok, `Review artifact ${reference.id} could not be read.`);
      artifactSummary.push(summarizeArtifact(parsed.artifact));
    }
    assert(
      artifactSummary.length ===
        generatedState.candidate.reviewArtifacts.length,
      "The harness did not inspect every review artifact."
    );

    const decided = await decideGutenbergV2Candidate({
      siteId,
      requestId,
      candidateId,
      decision: "approved"
    });
    if (!("state" in decided)) {
      throw new Error(
        `Candidate approval failed (${"code" in decided ? decided.code : "missing state"}).`
      );
    }
    const approvedState = gutenbergV2RequestStateSchema.parse(decided.state);
    assert(
      approvedState.candidate?.candidateId === candidateId,
      "Approval was not bound to the exact generated candidate."
    );

    const firstExecution = await executeGutenbergV2Candidate({
      siteId,
      requestId
    });
    if (!("state" in firstExecution)) {
      throw new Error(
        `Candidate execution failed (${"code" in firstExecution ? firstExecution.code : "missing state"}).`
      );
    }
    const firstState = gutenbergV2RequestStateSchema.parse(
      firstExecution.state
    );
    assert(firstState.state === "succeeded", "Execution did not succeed.");
    assert(
      typeof firstState.result?.postId === "number",
      "Execution did not return the created post id."
    );
    postId = firstState.result.postId;

    const secondExecution = await executeGutenbergV2Candidate({
      siteId,
      requestId
    });
    if (!("state" in secondExecution)) {
      throw new Error(
        `Repeated execution failed (${"code" in secondExecution ? secondExecution.code : "missing state"}).`
      );
    }
    const secondState = gutenbergV2RequestStateSchema.parse(
      secondExecution.state
    );
    assert(
      secondState.result?.executionId === firstState.result?.executionId &&
        secondState.result?.idempotencyKey ===
          firstState.result?.idempotencyKey,
      "Repeated execution did not reuse the durable result mapping."
    );

    const persistedRequest =
      await database.repositories.requests.getById(requestId);
    assert(
      persistedRequest,
      "The E2E request disappeared from the desktop database."
    );
    assert(
      persistedRequest.latestPlanId === undefined &&
        persistedRequest.latestExecutionRunId === undefined,
      "The v2 request acquired a legacy v1 plan or execution mapping."
    );
    const engine = database.connection
      .prepare<
        { requestId: string },
        { contentEngine: string | null }
      >("SELECT content_engine AS contentEngine FROM requests WHERE id = @requestId")
      .get({ requestId });
    assert(
      engine?.contentEngine === "gutenberg_v2",
      "The request engine marker is not v2."
    );
    assert(
      hasGutenbergV2RequestMapping(siteId, requestId),
      "The v2 mapping was not durable."
    );

    const v1Collision = await generateActionPlanForRequest(
      siteId,
      thread.thread.id,
      requestId
    );
    assert(
      "code" in v1Collision && v1Collision.code === "request_engine_conflict",
      "The legacy v1 planner accepted a v2-owned request."
    );
  } finally {
    configureGutenbergV2PlannerFactory(undefined);
    resetRuntimeContext();
    database.close();
    rmSync(runtimeDir, { recursive: true, force: true });
    console.log(
      JSON.stringify(
        {
          siteId,
          requestId,
          postId,
          artifacts: artifactSummary,
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
  console.error(
    error instanceof Error ? error.message : "Gutenberg v2 chat E2E failed."
  );
  process.exitCode = 1;
});
