/**
 * ACF blocks end to end against a site that has ACF blocks (Phase 2).
 *
 * 1. Runs the per-site save-and-reopen fixture for every ACF block and
 *    checks the plugin recorded the result.
 * 2. Creates a draft page with an `acf/container` holding core blocks.
 * 3. Edits an existing container page: changes its fields and inserts a
 *    block inside it, keeping everything else byte-for-byte.
 *
 * Needs SITEPILOT_E2E_BASE_URL, SITEPILOT_E2E_ADMIN_USERNAME and
 * SITEPILOT_E2E_REGISTRATION_CODE for the ACF site. Set
 * SITEPILOT_ACF_SOURCE_POST_ID to a draft page whose content is one
 * `acf/container` block to run step 3. Set SITEPILOT_ACF_LLM=1 (with an
 * OpenAI key) to also plan a container page from a plain request.
 */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  gutenbergV2AcfDataFromFields,
  gutenbergV2BlockPlanSchema,
  type GutenbergV2AcfBlockDefinition,
  type GutenbergV2Approval,
  type GutenbergV2BlockPlan,
  type GutenbergV2CompiledCandidate
} from "@sitepilot/contracts";
import { createSignedGutenbergV2Runtime } from "@sitepilot/gutenberg-worker";
import { createOpenAiChatClient } from "@sitepilot/provider-adapters";
import {
  FileGutenbergV2StagedAssetStore,
  GutenbergV2ContentService,
  buildLlmGutenbergV2Plan,
  GutenbergV2ServiceError,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal,
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

const CONTAINER = "acf/container";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function register(): Promise<{
  siteId: string;
  clientId: string;
  secret: Buffer;
}> {
  const protocol = (await (
    await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`)
  ).json()) as { protocol_version?: string };
  assert(
    protocol.protocol_version,
    "Protocol endpoint omitted protocol_version."
  );
  const siteId = randomUUID();
  const clientId = `sitepilot-v2-acf-e2e-${randomUUID()}`;
  const secret = randomBytes(32);
  const response = await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/register`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      registrationCode: E2E_REGISTRATION_CODE,
      siteId,
      workspaceId: "sitepilot-v2-acf-e2e",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: clientId,
      wordpressUsername: E2E_ADMIN_USERNAME,
      protocolVersion: protocol.protocol_version,
      siteName: "SitePilot v2 ACF E2E",
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
    approverId: "sitepilot-v2-acf-e2e",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
}

async function execute(
  service: GutenbergV2ContentService,
  plan: GutenbergV2BlockPlan,
  label: string
): Promise<{ postId: number; content: string }> {
  const executionId = `acf-${label}-${randomUUID()}`;
  let candidate: GutenbergV2CompiledCandidate;
  try {
    candidate = await service.compileCandidate({
      executionId,
      idempotencyKey: `acf-${label}-${randomUUID()}`,
      plan
    });
  } catch (error) {
    if (error instanceof GutenbergV2ServiceError) {
      console.error(
        `${label} compile failed: ${JSON.stringify({ code: error.code, message: error.message, issues: error.issues.slice(0, 8) })}`
      );
    }
    throw error;
  }
  await service.recordApproval({ executionId, approval: approval(candidate) });
  const result = await service.executeApprovedCandidate({ executionId });
  assert(
    result.state === "succeeded" && result.postId,
    `${label} ended in ${result.state}: ${JSON.stringify(result).slice(0, 800)}`
  );
  return { postId: result.postId, content: candidate.serializedContent };
}

function containerNode(
  definition: GutenbergV2AcfBlockDefinition,
  ref: string,
  fields: Record<string, unknown>,
  children: Array<Record<string, unknown>>
) {
  return {
    ref,
    name: CONTAINER,
    attributes: {
      name: CONTAINER,
      data: gutenbergV2AcfDataFromFields(definition, fields),
      align: definition.defaultAlign ?? "",
      mode: "preview"
    },
    children
  };
}

async function main(): Promise<void> {
  const artifactDirectory = join(E2E_ARTIFACTS_ROOT, `v2-acf-${Date.now()}`);
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
  const report: Record<string, unknown> = { baseUrl: E2E_BASE_URL };
  try {
    // 1. Fixtures.
    const statuses = await runtime.runBlockFixtures();
    report.fixtures = statuses;
    console.log(
      statuses
        .map(
          (status) =>
            `${status.blockName}: ${status.status}${status.message ? ` (${status.message})` : ""}`
        )
        .join("\n")
    );
    const container = statuses.find((status) => status.blockName === CONTAINER);
    assert(
      container?.status === "passed",
      `${CONTAINER} did not pass its fixture: ${JSON.stringify(container)}`
    );

    const database = new Database(join(artifactDirectory, "journal.sqlite"));
    const service = new GutenbergV2ContentService({
      worker,
      wordpress: transport,
      journal: new SqliteGutenbergV2ExecutionJournal(database),
      approvals: new SqliteGutenbergV2ApprovalStore(database),
      media
    });
    const capabilities = await worker.discoverCapabilities({
      siteId: registration.siteId,
      postType: "page"
    });
    const capability = capabilities.blocks.find(
      (block) => block.name === CONTAINER
    );
    assert(
      capability?.v2Support === "author_when_reviewed" && capability.acf,
      `${CONTAINER} is not authorable after its fixture: ${JSON.stringify(capability).slice(0, 400)}`
    );
    const definition = capability.acf;

    // 2. Create a draft page with a container holding core blocks.
    const created = await execute(
      service,
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId: registration.siteId,
        operation: "create_draft",
        target: { postType: "page" },
        postFields: {
          title: `AUTOMATED-TEST-V2-ACF-${randomUUID()}`,
          status: "draft"
        },
        blocks: [
          containerNode(
            definition,
            "container-1",
            { colour: "grey", padding_amount: "none" },
            [
              {
                ref: "container-heading",
                name: "core/heading",
                attributes: { content: "Inside an ACF container", level: 2 },
                children: []
              },
              {
                ref: "container-paragraph",
                name: "core/paragraph",
                attributes: {
                  content: "Written by SitePilot v2 through the native editor."
                },
                children: []
              }
            ]
          )
        ],
        media: []
      }),
      "create"
    );
    assert(
      created.content.includes(
        '"colour":"bg-gray-300","_colour":"field_container_colour"'
      ) &&
        created.content.includes('"padding_amount":"py-0"') &&
        created.content.includes('"bottom_border":"1"'),
      `Created container data is wrong: ${created.content.slice(0, 600)}`
    );
    report.created = created;

    // 3. Edit an existing container page.
    const sourcePostId = Number(process.env.SITEPILOT_ACF_SOURCE_POST_ID ?? "");
    if (Number.isInteger(sourcePostId) && sourcePostId > 0) {
      const source = await worker.readSource({
        executionId: `acf-source-${randomUUID()}`,
        siteId: registration.siteId,
        postType: "page",
        postId: sourcePostId
      });
      const root = source.blockIndex.find(
        (entry) => entry.path.length === 1 && entry.name === CONTAINER
      );
      assert(
        root?.role === "authorable",
        `The container in ${sourcePostId} should be authorable: ${JSON.stringify(source.blockIndex).slice(0, 500)}`
      );
      const edited = await execute(
        service,
        gutenbergV2BlockPlanSchema.parse({
          schemaVersion: "sitepilot.block-plan/v2",
          planId: `plan-${randomUUID()}`,
          siteId: registration.siteId,
          operation: "apply_operations",
          target: {
            postId: source.postId,
            postType: source.postType,
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
          operations: [
            {
              id: "insert-inside-container",
              type: "insert_blocks",
              parent: {
                path: root.path,
                expectedFingerprint: root.fingerprint
              },
              index: 0,
              blocks: [
                {
                  ref: "inserted-paragraph",
                  name: "core/paragraph",
                  attributes: {
                    content: "Inserted inside the existing container."
                  },
                  children: []
                }
              ]
            },
            {
              id: "recolour-container",
              type: "edit_block",
              target: {
                path: root.path,
                expectedFingerprint: root.fingerprint
              },
              replacement: {
                ref: "recoloured-container",
                name: CONTAINER,
                attributes: {
                  name: CONTAINER,
                  data: gutenbergV2AcfDataFromFields(
                    definition,
                    { colour: "brand accent" },
                    { partial: true }
                  ),
                  mode: "preview"
                },
                children: []
              }
            }
          ],
          media: []
        }),
        "edit"
      );
      assert(
        edited.content.includes('"colour":"bg-brand-accent"') &&
          edited.content.includes("Inserted inside the existing container."),
        `Edited container is wrong: ${edited.content.slice(0, 800)}`
      );
      report.edited = edited;
    }

    // 4. Plan from a plain request with the real planner.
    if (process.env.SITEPILOT_ACF_LLM === "1" && E2E_OPENAI_API_KEY) {
      const planned = await buildLlmGutenbergV2Plan({
        request:
          "Create a page titled 'ACF container test' with a grey container that has no padding and no bottom border. Inside it put a heading 'Opening hours' and a short paragraph about weekday opening times.",
        siteId: registration.siteId,
        target: { operation: "create_draft", postType: "page" },
        capabilities,
        client: createOpenAiChatClient(E2E_OPENAI_API_KEY),
        model: process.env.SITEPILOT_ACF_LLM_MODEL ?? "gpt-4o-mini"
      });
      const llm = await execute(service, planned.plan, "llm");
      assert(
        llm.content.includes('"colour":"bg-gray-300"') &&
          llm.content.includes('"padding_amount":"py-0"') &&
          llm.content.includes('"bottom_border":"0"') &&
          llm.content.includes("Opening hours"),
        `The planned container is wrong: ${llm.content.slice(0, 900)}`
      );
      report.llm = llm;
    }
    console.log(
      `ACF E2E passed. Report: ${join(artifactDirectory, "report.json")}`
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
