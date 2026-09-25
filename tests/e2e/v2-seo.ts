/**
 * SEO fields end to end (Phase 3) against a site running Yoast SEO.
 *
 * 1. Creates a draft with SEO fields and reads the Yoast meta back.
 * 2. Changes only SEO fields on that post (no content operations).
 * 3. Refuses to write an approved SEO change after someone edited the
 *    post's SEO fields in WordPress.
 * 4. Rolls a committed SEO change back to the exact previous meta.
 * 5. Refuses that rollback when the SEO fields were edited after the write.
 *
 * Needs SITEPILOT_E2E_BASE_URL, SITEPILOT_E2E_ADMIN_USERNAME,
 * SITEPILOT_E2E_REGISTRATION_CODE and SITEPILOT_E2E_WP_PATH (the site's
 * WordPress directory, for `wp` CLI checks). SITEPILOT_SEO_LLM=1 (with an
 * OpenAI key) also plans an SEO change from a plain request.
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
  type GutenbergV2CompiledCandidate,
  type GutenbergV2SeoChanges
} from "@sitepilot/contracts";
import { createSignedGutenbergV2Runtime } from "@sitepilot/gutenberg-worker";
import { createOpenAiChatClient } from "@sitepilot/provider-adapters";
import {
  FileGutenbergV2StagedAssetStore,
  GutenbergV2ContentService,
  GutenbergV2ServiceError,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal,
  buildLlmGutenbergV2Plan,
  createGutenbergV2ApprovalBinding,
  hashGutenbergV2Value
} from "@sitepilot/services";

import {
  E2E_ADMIN_USERNAME,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL,
  E2E_OPENAI_API_KEY,
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

function meta(postId: number): Record<string, string> {
  const rows = JSON.parse(
    wp("post", "meta", "list", String(postId), "--format=json")
  ) as Array<{ meta_key: string; meta_value: string }>;
  return Object.fromEntries(
    rows
      .filter((row) => row.meta_key.startsWith("_yoast_wpseo_"))
      .map((row) => [row.meta_key, row.meta_value])
  );
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
  const clientId = `sitepilot-v2-seo-e2e-${randomUUID()}`;
  const secret = randomBytes(32);
  const response = await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/register`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      registrationCode: E2E_REGISTRATION_CODE,
      siteId,
      workspaceId: "sitepilot-v2-seo-e2e",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: clientId,
      wordpressUsername: E2E_ADMIN_USERNAME,
      protocolVersion: protocol.protocol_version,
      siteName: "SitePilot v2 SEO E2E",
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
    approverId: "sitepilot-v2-seo-e2e",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
}

async function main(): Promise<void> {
  assert(
    WP_PATH,
    "Set SITEPILOT_E2E_WP_PATH to the site's WordPress directory."
  );
  const artifactDirectory = join(E2E_ARTIFACTS_ROOT, `v2-seo-${Date.now()}`);
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
  const service = new GutenbergV2ContentService({
    worker,
    wordpress: transport,
    journal: new SqliteGutenbergV2ExecutionJournal(database),
    approvals: new SqliteGutenbergV2ApprovalStore(database),
    media
  });
  const report: Record<string, unknown> = { baseUrl: E2E_BASE_URL };

  const compile = async (plan: GutenbergV2BlockPlan, label: string) => {
    const executionId = `seo-${label}-${randomUUID()}`;
    try {
      const candidate = await service.compileCandidate({
        executionId,
        idempotencyKey: `seo-${label}-${randomUUID()}`,
        plan
      });
      await service.recordApproval({
        executionId,
        approval: approval(candidate)
      });
      return { executionId, candidate };
    } catch (error) {
      if (error instanceof GutenbergV2ServiceError) {
        console.error(
          `${label} compile failed: ${error.code} ${error.message} ${JSON.stringify(error.issues.slice(0, 5))}`
        );
      }
      throw error;
    }
  };
  const execute = async (plan: GutenbergV2BlockPlan, label: string) => {
    const { executionId } = await compile(plan, label);
    const result = await service.executeApprovedCandidate({ executionId });
    assert(
      result.state === "succeeded" && result.postId,
      `${label} ended in ${result.state}: ${JSON.stringify(result.verification.issues).slice(0, 600)}`
    );
    return result.postId;
  };
  const seoEdit = async (postId: number, seo: GutenbergV2SeoChanges) => {
    const source = await worker.readSource({
      executionId: `seo-source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId
    });
    assert(source.seo, `Post ${postId} did not report its SEO fields.`);
    return gutenbergV2BlockPlanSchema.parse({
      schemaVersion: "sitepilot.block-plan/v2",
      planId: `plan-${randomUUID()}`,
      siteId: registration.siteId,
      operation: "apply_operations",
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
      postFields: { seo },
      operations: [],
      media: []
    });
  };

  try {
    const capabilities = await worker.discoverCapabilities({
      siteId: registration.siteId,
      postType: "post"
    });
    assert(
      capabilities.seo?.plugin === "yoast",
      `The editor did not report Yoast SEO: ${JSON.stringify(capabilities.seo)}`
    );

    // 1. Create a draft with SEO fields.
    const postId = await execute(
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "create_draft",
        target: { postType: "post" },
        postFields: {
          title: `AUTOMATED-TEST-V2-SEO-${randomUUID()}`,
          status: "draft",
          seo: {
            title: "%%title%% %%sep%% Opening hours",
            description: "Weekday opening times and holiday hours.",
            focusKeyphrase: "opening hours",
            indexing: "noindex"
          }
        },
        blocks: [
          {
            ref: "p",
            name: "core/paragraph",
            attributes: { content: "We are open weekdays." },
            children: []
          }
        ],
        media: []
      }),
      "create"
    );
    let stored = meta(postId);
    assert(
      stored._yoast_wpseo_title === "%%title%% %%sep%% Opening hours" &&
        stored._yoast_wpseo_metadesc ===
          "Weekday opening times and holiday hours." &&
        stored._yoast_wpseo_focuskw === "opening hours" &&
        stored["_yoast_wpseo_meta-robots-noindex"] === "1",
      `Created SEO meta is wrong: ${JSON.stringify(stored)}`
    );
    report.created = { postId, meta: stored };

    // 2. SEO-only change: edit one field, clear one, allow indexing.
    await execute(
      await seoEdit(postId, {
        description: "Open 9 to 5, Monday to Friday.",
        focusKeyphrase: "",
        indexing: "index"
      }),
      "seo-only"
    );
    stored = meta(postId);
    assert(
      stored._yoast_wpseo_metadesc === "Open 9 to 5, Monday to Friday." &&
        stored._yoast_wpseo_focuskw === undefined &&
        stored["_yoast_wpseo_meta-robots-noindex"] === "2" &&
        stored._yoast_wpseo_title === "%%title%% %%sep%% Opening hours",
      `SEO-only edit is wrong: ${JSON.stringify(stored)}`
    );
    report.seoOnly = stored;

    // 3. A human edits the SEO fields after approval: the write is refused.
    const stale = await compile(
      await seoEdit(postId, { description: "Approved but stale." }),
      "stale"
    );
    wp(
      "post",
      "meta",
      "update",
      String(postId),
      "_yoast_wpseo_metadesc",
      "Edited in WordPress."
    );
    let staleCode = "";
    try {
      const result = await service.executeApprovedCandidate({
        executionId: stale.executionId
      });
      staleCode = result.state;
    } catch (error) {
      staleCode =
        error instanceof GutenbergV2ServiceError ? error.code : String(error);
    }
    assert(
      meta(postId)._yoast_wpseo_metadesc === "Edited in WordPress.",
      "A stale SEO change overwrote a later WordPress edit."
    );
    assert(
      /stale_source|pre_write_failed/.test(staleCode),
      `Stale SEO change was not refused: ${staleCode}`
    );
    report.stale = staleCode;

    // 4. Commit an SEO change, then roll it back to the exact previous meta.
    const before = meta(postId);
    const rollback = await compile(
      await seoEdit(postId, {
        title: "Rolled back title",
        socialTitle: "Social"
      }),
      "rollback"
    );
    await service.prepareCommit({ executionId: rollback.executionId });
    const receipt = await service.commitCandidate({
      executionId: rollback.executionId
    });
    assert(
      meta(postId)._yoast_wpseo_title === "Rolled back title",
      "The SEO change was not committed."
    );
    const recovered = await transport.conditionalRollback({
      schemaVersion: "sitepilot.recover-request/v2",
      siteId: registration.siteId,
      executionId: rollback.executionId,
      postId,
      beforeStateRef: receipt.beforeStateRef,
      expectedWrittenContentHash: receipt.persistedContentHash,
      expectedWrittenRevision: receipt.persistedRevision,
      expectedWrittenFieldsHash: receipt.persistedFieldsHash
    });
    assert(
      recovered.outcome === "restored",
      `Rollback outcome ${recovered.outcome}.`
    );
    assert(
      JSON.stringify(meta(postId)) === JSON.stringify(before),
      `Rollback did not restore the SEO meta: ${JSON.stringify(meta(postId))} vs ${JSON.stringify(before)}`
    );
    report.rollback = recovered.outcome;

    // 5. A human edits SEO after the write: the rollback refuses to overwrite it.
    const conflict = await compile(
      await seoEdit(postId, { title: "Written by SitePilot" }),
      "conflict"
    );
    await service.prepareCommit({ executionId: conflict.executionId });
    const conflictReceipt = await service.commitCandidate({
      executionId: conflict.executionId
    });
    wp(
      "post",
      "meta",
      "update",
      String(postId),
      "_yoast_wpseo_title",
      "Human title after the write"
    );
    const refused = await transport.conditionalRollback({
      schemaVersion: "sitepilot.recover-request/v2",
      siteId: registration.siteId,
      executionId: conflict.executionId,
      postId,
      beforeStateRef: conflictReceipt.beforeStateRef,
      expectedWrittenContentHash: conflictReceipt.persistedContentHash,
      expectedWrittenRevision: conflictReceipt.persistedRevision,
      expectedWrittenFieldsHash: conflictReceipt.persistedFieldsHash
    });
    assert(
      refused.outcome === "conflict",
      `Rollback over a later SEO edit returned ${refused.outcome}.`
    );
    assert(
      meta(postId)._yoast_wpseo_title === "Human title after the write",
      "Rollback overwrote a later SEO edit."
    );
    report.rollbackConflict = refused.outcome;

    // 6. Plan an SEO change from a plain request.
    if (process.env.SITEPILOT_SEO_LLM === "1" && E2E_OPENAI_API_KEY) {
      const source = await worker.readSource({
        executionId: `seo-llm-source-${randomUUID()}`,
        siteId: registration.siteId,
        postType: "post",
        postId
      });
      const planned = await buildLlmGutenbergV2Plan({
        request:
          "Change the meta description to 'Find our weekday and weekend opening times.' and hide this post from search engines. Don't change anything else.",
        siteId: registration.siteId,
        target: { operation: "apply_operations", source },
        capabilities,
        client: createOpenAiChatClient(E2E_OPENAI_API_KEY),
        model: process.env.SITEPILOT_SEO_LLM_MODEL ?? "gpt-4o-mini"
      });
      assert(
        planned.plan.operation === "apply_operations" &&
          planned.plan.operations.length === 0,
        `The planner changed content for an SEO-only request: ${JSON.stringify(planned.plan).slice(0, 600)}`
      );
      await execute(planned.plan, "llm");
      stored = meta(postId);
      assert(
        stored._yoast_wpseo_metadesc ===
          "Find our weekday and weekend opening times." &&
          stored["_yoast_wpseo_meta-robots-noindex"] === "1" &&
          stored._yoast_wpseo_title === "Human title after the write",
        `The planned SEO change is wrong: ${JSON.stringify(stored)}`
      );
      report.llm = { postFields: planned.plan.postFields, meta: stored };
    }
    console.log(
      `SEO E2E passed on post ${postId}. Report: ${join(artifactDirectory, "report.json")}`
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
