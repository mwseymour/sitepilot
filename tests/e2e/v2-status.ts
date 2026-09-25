/**
 * Publish and unpublish end to end (Phase 4).
 *
 * 1. Creates a draft (content is always created as a draft).
 * 2. Publishes it as its own approved step; the URL must load publicly.
 * 3. Unpublishes it; the URL must stop loading publicly.
 * 4. Refuses transitions that don't apply (unpublishing a draft).
 * 5. Refuses an approved publish after the post changed in WordPress.
 * 6. Rolls a publish back to draft when its URL does not load.
 *
 * Needs SITEPILOT_E2E_BASE_URL, SITEPILOT_E2E_ADMIN_USERNAME,
 * SITEPILOT_E2E_REGISTRATION_CODE and SITEPILOT_E2E_WP_PATH.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
  GutenbergV2ServiceError,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal,
  createGutenbergV2ApprovalBinding,
  hashGutenbergV2Value,
  type GutenbergV2WordPressTransport
} from "@sitepilot/services";

import {
  E2E_ADMIN_USERNAME,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL,
  E2E_REGISTRATION_CODE
} from "./config.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const WP_PATH = process.env.SITEPILOT_E2E_WP_PATH ?? "";

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
  ).json()) as { protocol_version?: string };
  assert(
    protocol.protocol_version,
    "Protocol endpoint omitted protocol_version."
  );
  const siteId = randomUUID();
  const clientId = `sitepilot-v2-status-e2e-${randomUUID()}`;
  const secret = randomBytes(32);
  const response = await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/register`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      registrationCode: E2E_REGISTRATION_CODE,
      siteId,
      workspaceId: "sitepilot-v2-status-e2e",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: clientId,
      wordpressUsername: E2E_ADMIN_USERNAME,
      protocolVersion: protocol.protocol_version,
      siteName: "SitePilot v2 status E2E",
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
    approverId: "sitepilot-v2-status-e2e",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
}

async function anonymousStatus(url: string): Promise<number> {
  const response = await fetch(
    `${url}${url.includes("?") ? "&" : "?"}e2e=${randomUUID()}`,
    {
      redirect: "follow"
    }
  );
  return response.status;
}

async function main(): Promise<void> {
  assert(
    WP_PATH,
    "Set SITEPILOT_E2E_WP_PATH to the site's WordPress directory."
  );
  const artifactDirectory = join(E2E_ARTIFACTS_ROOT, `v2-status-${Date.now()}`);
  mkdirSync(artifactDirectory, { recursive: true });
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
  const database = new Database(join(artifactDirectory, "journal.sqlite"));
  const serviceFor = (wordpress: GutenbergV2WordPressTransport) =>
    new GutenbergV2ContentService({
      worker,
      wordpress,
      journal: new SqliteGutenbergV2ExecutionJournal(database),
      approvals: new SqliteGutenbergV2ApprovalStore(database),
      media
    });
  const service = serviceFor(transport);
  const report: Record<string, unknown> = { baseUrl: E2E_BASE_URL };

  const compile = async (
    plan: GutenbergV2BlockPlan,
    label: string,
    using = service
  ) => {
    const executionId = `status-${label}-${randomUUID()}`;
    const candidate = await using.compileCandidate({
      executionId,
      idempotencyKey: `status-${label}-${randomUUID()}`,
      plan
    });
    await using.recordApproval({ executionId, approval: approval(candidate) });
    return { executionId, candidate };
  };
  const statusPlan = async (postId: number, to: "publish" | "draft") => {
    const source = await worker.readSource({
      executionId: `status-source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId
    });
    return {
      source,
      plan: gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "set_status",
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
        status: { to },
        media: []
      })
    };
  };
  const createDraft = async (label: string): Promise<number> => {
    const { executionId } = await compile(
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "create_draft",
        target: { postType: "post" },
        postFields: {
          title: `AUTOMATED-TEST-V2-STATUS-${label}-${randomUUID().slice(0, 8)}`,
          status: "draft"
        },
        blocks: [
          {
            ref: "p",
            name: "core/paragraph",
            attributes: { content: "Status test." },
            children: []
          }
        ],
        media: []
      }),
      `create-${label}`
    );
    const result = await service.executeApprovedCandidate({ executionId });
    assert(
      result.state === "succeeded" && result.postId,
      `Draft ${label} ended in ${result.state}.`
    );
    assert(
      wp("post", "get", String(result.postId), "--field=post_status") ===
        "draft",
      "Content was not created as a draft."
    );
    return result.postId;
  };

  try {
    // 1. Draft.
    const postId = await createDraft("main");

    // 2. Publish.
    const toPublish = await statusPlan(postId, "publish");
    assert(
      toPublish.source.publicUrl,
      "The source did not report the URL the post will have."
    );
    const published = await compile(toPublish.plan, "publish");
    assert(
      published.candidate.serializedContent === toPublish.source.rawContent,
      "A status candidate changed content."
    );
    const publishResult = await service.executeApprovedCandidate({
      executionId: published.executionId
    });
    assert(
      publishResult.state === "succeeded",
      `Publish ended in ${publishResult.state}: ${JSON.stringify(publishResult.verification.issues)}`
    );
    assert(
      wp("post", "get", String(postId), "--field=post_status") === "publish",
      "The post is not published."
    );
    const liveUrl = wp("post", "url", String(postId));
    assert(
      liveUrl === toPublish.source.publicUrl,
      `The published URL ${liveUrl} differs from the one shown for approval (${toPublish.source.publicUrl}).`
    );
    assert(
      (await anonymousStatus(liveUrl)) === 200,
      `${liveUrl} does not load publicly after publishing.`
    );
    report.published = { postId, liveUrl };

    // 3. Unpublish.
    const unpublished = await compile(
      (await statusPlan(postId, "draft")).plan,
      "unpublish"
    );
    const unpublishResult = await service.executeApprovedCandidate({
      executionId: unpublished.executionId
    });
    assert(
      unpublishResult.state === "succeeded",
      `Unpublish ended in ${unpublishResult.state}: ${JSON.stringify(unpublishResult.verification.issues)}`
    );
    assert(
      wp("post", "get", String(postId), "--field=post_status") === "draft",
      "The post was not unpublished."
    );
    assert(
      (await anonymousStatus(liveUrl)) !== 200,
      `${liveUrl} still loads after unpublishing.`
    );
    report.unpublished = true;

    // 4. Transitions that don't apply are refused before approval.
    let refusal = "";
    try {
      await compile(
        (await statusPlan(postId, "draft")).plan,
        "unpublish-draft"
      );
    } catch (error) {
      refusal =
        error instanceof GutenbergV2ServiceError
          ? error.message
          : String(error);
    }
    assert(
      /nothing to unpublish/.test(refusal),
      `Unpublishing a draft was not refused: ${refusal}`
    );
    report.refusedTransition = refusal;

    // 5. The post changes after approval: the publish is refused.
    const stale = await compile(
      (await statusPlan(postId, "publish")).plan,
      "stale"
    );
    wp(
      "post",
      "update",
      String(postId),
      "--post_title=Edited in WordPress after approval"
    );
    let staleOutcome = "";
    try {
      staleOutcome = (
        await service.executeApprovedCandidate({
          executionId: stale.executionId
        })
      ).state;
    } catch (error) {
      staleOutcome =
        error instanceof GutenbergV2ServiceError ? error.code : String(error);
    }
    assert(
      /stale_source/.test(staleOutcome),
      `A stale publish was not refused: ${staleOutcome}`
    );
    assert(
      wp("post", "get", String(postId), "--field=post_status") === "draft",
      "A stale publish went live."
    );
    report.stale = staleOutcome;

    // 6. The URL check fails: the publish is rolled back to draft.
    const rollbackPost = await createDraft("rollback");
    const brokenCheck: GutenbergV2WordPressTransport = {
      readSource: (input) => transport.readSource(input),
      prepareCommit: (input) => transport.prepareCommit(input),
      commitCandidate: (input) => transport.commitCandidate(input),
      reconcileExecution: (input) => transport.reconcileExecution(input),
      readBack: (input) => transport.readBack(input),
      conditionalRollback: (input) => transport.conditionalRollback(input),
      checkPublicUrl: async (url) => ({ status: 404, finalUrl: url })
    };
    const failing = serviceFor(brokenCheck);
    const failingPublish = await compile(
      (await statusPlan(rollbackPost, "publish")).plan,
      "rollback",
      failing
    );
    const rolledBack = await failing.executeApprovedCandidate({
      executionId: failingPublish.executionId
    });
    assert(
      rolledBack.state === "rolled_back",
      `A publish whose URL failed ended in ${rolledBack.state}.`
    );
    assert(
      wp("post", "get", String(rollbackPost), "--field=post_status") ===
        "draft",
      "The failed publish was not rolled back to draft."
    );
    report.rollback = {
      postId: rollbackPost,
      state: rolledBack.state,
      issues: rolledBack.verification.issues.map((entry) => entry.message)
    };

    console.log(
      `Status E2E passed on posts ${postId} and ${rollbackPost}. Report: ${join(artifactDirectory, "report.json")}`
    );
  } finally {
    writeFileSync(
      join(artifactDirectory, "report.json"),
      JSON.stringify(report, null, 2)
    );
    await worker.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exitCode = 1;
});
