/**
 * Render check end to end (hardening Phase 6), against the MAMP site:
 *
 * 1. A new draft that doesn't render is kept, and the job fails with the reason.
 * 2. An edit that breaks a post which rendered before is rolled back.
 *
 * A test-only mu-plugin (tests/e2e/wordpress/sitepilot-render-boom.php) makes
 * any block containing SITEPILOT_RENDER_BOOM throw while rendering. This script
 * installs it in the site's mu-plugins and removes it at the end. Needs
 * SITEPILOT_E2E_WP_PATH.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  gutenbergV2BlockPlanSchema,
  type GutenbergV2Approval,
  type GutenbergV2BlockPlan,
  type GutenbergV2CompiledCandidate
} from "@sitepilot/contracts";
import { createSignedGutenbergV2Runtime } from "@sitepilot/gutenberg-worker";
import {
  FileGutenbergV2StagedAssetStore,
  GutenbergV2ContentService,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal,
  createGutenbergV2ApprovalBinding,
  hashGutenbergV2Value
} from "@sitepilot/services";

import {
  E2E_ADMIN_USERNAME,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL,
  E2E_WP_PATH
} from "./config.js";
import { currentRegistrationCode } from "./registration.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const WP_PATH = E2E_WP_PATH ?? "";
const MARKER = "SITEPILOT_RENDER_BOOM";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function wp(...args: string[]): string {
  return execFileSync("wp", args, {
    cwd: WP_PATH,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function register() {
  const protocol = (await (
    await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`)
  ).json()) as { protocol_version?: string; features?: string[] };
  assert(
    protocol.protocol_version,
    "Protocol endpoint omitted protocol_version."
  );
  assert(
    protocol.features?.includes("render_check_v1"),
    "The site's plugin doesn't advertise render_check_v1. Is its copy up to date?"
  );
  const siteId = randomUUID();
  const clientId = `sitepilot-v2-render-e2e-${randomUUID()}`;
  const secret = randomBytes(32);
  const response = await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/register`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      registrationCode: await currentRegistrationCode(),
      siteId,
      workspaceId: "sitepilot-v2-render-e2e",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: clientId,
      wordpressUsername: E2E_ADMIN_USERNAME,
      protocolVersion: protocol.protocol_version,
      siteName: "SitePilot v2 render check E2E",
      siteBaseUrl: E2E_BASE_URL.replace(/\/$/, ""),
      environment: "development",
      sharedSecretBase64: secret.toString("base64")
    })
  });
  const body = await response.text();
  assert(
    response.ok,
    `Registration failed with HTTP ${response.status}: ${body.slice(0, 500)}`
  );
  return { siteId, clientId, secret };
}

function approval(
  candidate: GutenbergV2CompiledCandidate
): GutenbergV2Approval {
  const now = new Date();
  return {
    schemaVersion: "sitepilot.approval/v2",
    approvalId: `approval-${randomUUID()}`,
    approverId: "sitepilot-v2-render-e2e",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
}

function paragraph(ref: string, content: string) {
  return { ref, name: "core/paragraph", attributes: { content }, children: [] };
}

async function main(): Promise<void> {
  assert(
    WP_PATH,
    "Set SITEPILOT_E2E_WP_PATH to the site's WordPress directory."
  );
  const muPluginDirectory = join(WP_PATH, "wp-content", "mu-plugins");
  const muPlugin = join(muPluginDirectory, "sitepilot-render-boom.php");
  mkdirSync(muPluginDirectory, { recursive: true });
  copyFileSync(
    join(process.cwd(), "tests/e2e/wordpress/sitepilot-render-boom.php"),
    muPlugin
  );

  const artifactDirectory = join(
    E2E_ARTIFACTS_ROOT,
    `v2-render-check-${Date.now()}`
  );
  mkdirSync(artifactDirectory, { recursive: true });
  const report: Record<string, unknown> = { baseUrl: E2E_BASE_URL };
  let closeWorker: (() => Promise<void>) | undefined;
  try {
    const registration = await register();
    const runtime = createSignedGutenbergV2Runtime({
      siteUrl: E2E_BASE_URL,
      siteId: registration.siteId,
      clientId: registration.clientId,
      sharedSecret: registration.secret,
      stagedAssets: new FileGutenbergV2StagedAssetStore(
        join(artifactDirectory, "staged-media")
      ),
      reviewArtifactDirectory: join(artifactDirectory, "review"),
      ignoreHTTPSErrors: true,
      maxConcurrentJobs: 1,
      jobTimeoutMs: 120_000
    });
    const { worker, transport, media } = runtime;
    closeWorker = () => worker.close();
    const database = new Database(join(artifactDirectory, "journal.sqlite"));
    const journal = new SqliteGutenbergV2ExecutionJournal(database);
    const service = new GutenbergV2ContentService({
      worker,
      wordpress: transport,
      journal,
      approvals: new SqliteGutenbergV2ApprovalStore(database),
      media
    });
    const execute = async (plan: GutenbergV2BlockPlan, label: string) => {
      const executionId = `render-${label}-${randomUUID()}`;
      const candidate = await service.compileCandidate({
        executionId,
        idempotencyKey: `render-${label}-${randomUUID()}`,
        plan
      });
      await service.recordApproval({
        executionId,
        approval: approval(candidate)
      });
      const result = await service.executeApprovedCandidate({ executionId });
      return { result, job: await journal.get(executionId) };
    };
    const draftPlan = (label: string, content: string) =>
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "create_draft",
        target: { postType: "post" },
        postFields: {
          title: `AUTOMATED-TEST-V2-RENDER-${label}-${randomUUID().slice(0, 8)}`,
          status: "draft"
        },
        blocks: [paragraph("p", content)],
        media: []
      });

    // 1. A new draft that doesn't render is kept and fails with the reason.
    const broken = await execute(
      draftPlan("broken-draft", `${MARKER} in a new draft.`),
      "draft"
    );
    assert(
      broken.result.state === "post_write_verification_failed",
      `A draft that doesn't render ended in ${broken.result.state}.`
    );
    assert(
      broken.job?.failure?.code === "render_failed",
      `The failed draft's reason was ${JSON.stringify(broken.job?.failure)}.`
    );
    assert(broken.result.postId, "The failed draft has no post ID.");
    assert(
      wp("post", "get", String(broken.result.postId), "--field=post_status") ===
        "draft",
      "The draft that doesn't render was not kept."
    );
    report.brokenDraft = {
      postId: broken.result.postId,
      failure: broken.job?.failure
    };

    // 2. An edit that breaks a post which rendered is rolled back.
    const clean = await execute(draftPlan("clean", "Renders fine."), "clean");
    assert(
      clean.result.state === "succeeded" && clean.result.postId,
      `The clean draft ended in ${clean.result.state}.`
    );
    const postId = clean.result.postId;
    const source = await worker.readSource({
      executionId: `render-source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId
    });
    const edit = await execute(
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "replace_content",
        target: {
          postId,
          postType: "post",
          sourceRevision: source.revision,
          sourceContentHash: source.contentHash,
          expectedFields: {
            title: {
              value: source.fields.title,
              valueHash: hashGutenbergV2Value(source.fields.title)
            },
            excerpt: {
              value: source.fields.excerpt,
              valueHash: hashGutenbergV2Value(source.fields.excerpt)
            }
          }
        },
        blocks: [paragraph("p", `${MARKER} breaks this post.`)],
        media: []
      }),
      "edit"
    );
    assert(
      edit.result.state === "rolled_back",
      `A breaking edit ended in ${edit.result.state}.`
    );
    assert(
      edit.job?.failure?.code === "render_failed",
      `The rollback's reason was ${JSON.stringify(edit.job?.failure)}.`
    );
    const restored = wp("post", "get", String(postId), "--field=post_content");
    assert(
      !restored.includes(MARKER) && restored.includes("Renders fine."),
      "The breaking edit was not rolled back."
    );
    report.rolledBack = { postId, failure: edit.job?.failure };

    database.close();
    console.log("v2 render check E2E passed.");
    console.log(
      JSON.stringify(
        {
          ...report,
          manualCleanup: `Delete draft posts ${broken.result.postId} and ${postId} from the managed MAMP site after review.`
        },
        null,
        2
      )
    );
  } finally {
    await closeWorker?.();
    if (existsSync(muPlugin)) rmSync(muPlugin);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
