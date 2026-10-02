/**
 * Categories and tags end to end, against the local test site.
 *
 * 1. Creates a draft with a category and a tag, and reads them back.
 * 2. Changes only the tags on that post (no content operations).
 * 3. Refuses to write an approved change after someone changed the post's
 *    tags in WordPress.
 * 4. Rolls a committed change back to the exact previous terms.
 * 5. Refuses that rollback when the terms were changed after the write.
 *
 * Needs SITEPILOT_E2E_BASE_URL, SITEPILOT_E2E_ADMIN_USERNAME and
 * SITEPILOT_E2E_WP_PATH (the site's WordPress directory, for `wp` CLI checks
 * and a fresh registration code). SITEPILOT_TERMS_LLM=1 (with an OpenAI key)
 * also plans a tag change from a plain request.
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
  type GutenbergV2TermChanges
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
  E2E_WP_PATH
} from "./config.js";
import { currentRegistrationCode } from "./registration.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const WP_PATH = E2E_WP_PATH ?? "";

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

/** A term the test owns, created once and reused. */
function term(taxonomy: string, name: string, slug: string): { id: number; name: string } {
  let id: string;
  try {
    id = wp("term", "get", taxonomy, slug, "--by=slug", "--field=term_id");
  } catch {
    id = wp("term", "create", taxonomy, name, `--slug=${slug}`, "--porcelain");
  }
  return { id: Number(id), name };
}

/** The post's term IDs in a taxonomy, sorted. */
function termIds(postId: number, taxonomy: string): number[] {
  const rows = JSON.parse(
    wp("post", "term", "list", String(postId), taxonomy, "--fields=term_id", "--format=json")
  ) as Array<{ term_id: number }>;
  return rows.map((row) => Number(row.term_id)).sort((a, b) => a - b);
}

async function register() {
  const protocol = (await (
    await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`)
  ).json()) as { protocol_version?: string };
  assert(protocol.protocol_version, "Protocol endpoint omitted protocol_version.");
  const siteId = randomUUID();
  const clientId = `sitepilot-v2-terms-e2e-${randomUUID()}`;
  const secret = randomBytes(32);
  const response = await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/register`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      registrationCode: await currentRegistrationCode(),
      siteId,
      workspaceId: "sitepilot-v2-terms-e2e",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: clientId,
      wordpressUsername: E2E_ADMIN_USERNAME,
      protocolVersion: protocol.protocol_version,
      siteName: "SitePilot v2 terms E2E",
      siteBaseUrl: E2E_BASE_URL.replace(/\/$/, ""),
      environment: "development",
      sharedSecretBase64: secret.toString("base64")
    })
  });
  const body = await response.text();
  assert(response.ok, `Registration failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  return { siteId, clientId, secret };
}

function approval(candidate: GutenbergV2CompiledCandidate): GutenbergV2Approval {
  const now = new Date();
  return {
    schemaVersion: "sitepilot.approval/v2",
    approvalId: `approval-${randomUUID()}`,
    approverId: "sitepilot-v2-terms-e2e",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
}

async function main(): Promise<void> {
  assert(WP_PATH, "Set SITEPILOT_E2E_WP_PATH to the site's WordPress directory.");
  const artifactDirectory = join(E2E_ARTIFACTS_ROOT, `v2-terms-${Date.now()}`);
  mkdirSync(artifactDirectory, { recursive: true });
  const category = term("category", "SitePilot E2E Places", "sitepilot-e2e-places");
  const walking = term("post_tag", "SitePilot E2E Walking", "sitepilot-e2e-walking");
  const lakes = term("post_tag", "SitePilot E2E Lakes", "sitepilot-e2e-lakes");
  const registration = await register();
  const runtime = createSignedGutenbergV2Runtime({
    siteUrl: E2E_BASE_URL,
    siteId: registration.siteId,
    clientId: registration.clientId,
    sharedSecret: registration.secret,
    stagedAssets: new FileGutenbergV2StagedAssetStore(join(artifactDirectory, "staged-media")),
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
    const executionId = `terms-${label}-${randomUUID()}`;
    try {
      const candidate = await service.compileCandidate({
        executionId,
        idempotencyKey: `terms-${label}-${randomUUID()}`,
        plan
      });
      await service.recordApproval({ executionId, approval: approval(candidate) });
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
  const termsEdit = async (postId: number, terms: GutenbergV2TermChanges) => {
    const source = await worker.readSource({
      executionId: `terms-source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId
    });
    assert(source.terms, `Post ${postId} did not report its categories and tags.`);
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
          title: { value: source.fields.title, valueHash: hashGutenbergV2Value(source.fields.title) },
          excerpt: { value: source.fields.excerpt, valueHash: hashGutenbergV2Value(source.fields.excerpt) }
        }
      },
      postFields: { terms },
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
      JSON.stringify(capabilities.terms?.taxonomies) === JSON.stringify(["category", "post_tag"]),
      `The editor did not offer categories and tags: ${JSON.stringify(capabilities.terms)}`
    );

    // 1. Create a draft with a category and a tag.
    const postId = await execute(
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "create_draft",
        target: { postType: "post" },
        postFields: {
          title: `AUTOMATED-TEST-V2-TERMS-${randomUUID()}`,
          terms: { category: [category], post_tag: [walking] },
          status: "draft"
        },
        blocks: [
          { ref: "p", name: "core/paragraph", attributes: { content: "A walk by the lake." }, children: [] }
        ],
        media: []
      }),
      "create"
    );
    assert(
      JSON.stringify(termIds(postId, "category")) === JSON.stringify([category.id]) &&
        JSON.stringify(termIds(postId, "post_tag")) === JSON.stringify([walking.id]),
      `Created terms are wrong: ${JSON.stringify({ category: termIds(postId, "category"), tags: termIds(postId, "post_tag") })}`
    );
    report.created = { postId };

    // 2. Tags only: add one.
    const bothTags = [walking, lakes].sort((a, b) => a.id - b.id);
    await execute(await termsEdit(postId, { post_tag: bothTags }), "tags-only");
    assert(
      JSON.stringify(termIds(postId, "post_tag")) === JSON.stringify(bothTags.map((tag) => tag.id)) &&
        JSON.stringify(termIds(postId, "category")) === JSON.stringify([category.id]),
      `Tags-only edit is wrong: ${JSON.stringify(termIds(postId, "post_tag"))}`
    );

    // 3. Someone changes the tags after approval: the write is refused.
    const stale = await compile(await termsEdit(postId, { post_tag: [walking] }), "stale");
    wp("post", "term", "remove", String(postId), "post_tag", String(walking.id), "--by=id");
    let staleCode = "";
    try {
      staleCode = (await service.executeApprovedCandidate({ executionId: stale.executionId })).state;
    } catch (error) {
      staleCode = error instanceof GutenbergV2ServiceError ? error.code : String(error);
    }
    assert(
      JSON.stringify(termIds(postId, "post_tag")) === JSON.stringify([lakes.id]),
      "A stale term change overwrote a later WordPress edit."
    );
    assert(/stale_source|pre_write_failed/.test(staleCode), `Stale term change was not refused: ${staleCode}`);
    report.stale = staleCode;

    // 4. Commit a change, then roll it back to the exact previous terms.
    const before = { category: termIds(postId, "category"), tags: termIds(postId, "post_tag") };
    const rollback = await compile(await termsEdit(postId, { post_tag: [walking] }), "rollback");
    await service.prepareCommit({ executionId: rollback.executionId });
    const receipt = await service.commitCandidate({ executionId: rollback.executionId });
    assert(
      JSON.stringify(termIds(postId, "post_tag")) === JSON.stringify([walking.id]),
      "The term change was not committed."
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
    assert(recovered.outcome === "restored", `Rollback outcome ${recovered.outcome}.`);
    const after = { category: termIds(postId, "category"), tags: termIds(postId, "post_tag") };
    assert(
      JSON.stringify(after) === JSON.stringify(before),
      `Rollback did not restore the terms: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`
    );
    report.rollback = recovered.outcome;

    // 5. Someone changes the tags after the write: the rollback refuses to overwrite it.
    const conflict = await compile(await termsEdit(postId, { post_tag: bothTags }), "conflict");
    await service.prepareCommit({ executionId: conflict.executionId });
    const conflictReceipt = await service.commitCandidate({ executionId: conflict.executionId });
    wp("post", "term", "remove", String(postId), "post_tag", String(lakes.id), "--by=id");
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
    assert(refused.outcome === "conflict", `Rollback over a later term edit returned ${refused.outcome}.`);
    assert(
      JSON.stringify(termIds(postId, "post_tag")) === JSON.stringify([walking.id]),
      "Rollback overwrote a later term edit."
    );
    report.rollbackConflict = refused.outcome;

    // 6. Plan a tag change from a plain request.
    if (process.env.SITEPILOT_TERMS_LLM === "1" && E2E_OPENAI_API_KEY) {
      const source = await worker.readSource({
        executionId: `terms-llm-source-${randomUUID()}`,
        siteId: registration.siteId,
        postType: "post",
        postId
      });
      const planned = await buildLlmGutenbergV2Plan({
        request: `Add the tag "${lakes.name}" to this post, and also tag it "Definitely Not A Real Tag". Don't change anything else.`,
        siteId: registration.siteId,
        target: { operation: "apply_operations", source },
        capabilities,
        availableTerms: { category: [category], post_tag: [walking, lakes] },
        client: createOpenAiChatClient(E2E_OPENAI_API_KEY),
        model: process.env.SITEPILOT_TERMS_LLM_MODEL ?? "gpt-5.4-mini"
      });
      assert(
        planned.plan.operation === "apply_operations" && planned.plan.operations.length === 0,
        `The planner changed content for a tags-only request: ${JSON.stringify(planned.plan).slice(0, 600)}`
      );
      await execute(planned.plan, "llm");
      assert(
        JSON.stringify(termIds(postId, "post_tag")) === JSON.stringify(bothTags.map((tag) => tag.id)),
        `The planned tag change is wrong: ${JSON.stringify(termIds(postId, "post_tag"))}`
      );
      report.llm = { postFields: planned.plan.postFields };
    }
    console.log(`Terms E2E passed on post ${postId}. Report: ${join(artifactDirectory, "report.json")}`);
  } finally {
    writeFileSync(join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
    await worker.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
