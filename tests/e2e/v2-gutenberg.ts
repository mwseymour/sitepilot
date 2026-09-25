import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext } from "playwright";

import {
  GUTENBERG_V2_SUPPORT_MATRIX,
  gutenbergV2BlockPlanSchema,
  type GutenbergV2Approval,
  type GutenbergV2BlockPlan,
  type GutenbergV2BlockNode,
  type GutenbergV2CompiledCandidate,
  type GutenbergV2EditorCapabilitySnapshot,
  type GutenbergV2MediaMapping
} from "@sitepilot/contracts";
import {
  WordPressEditorSessionClient,
  GutenbergV2WorkerError,
  createSignedGutenbergV2Runtime
} from "@sitepilot/gutenberg-worker";
import type { PlaywrightGutenbergV2Worker } from "@sitepilot/gutenberg-worker";
import {
  FileGutenbergV2StagedAssetStore,
  GutenbergV2ContentService,
  GutenbergV2ServiceError,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal,
  createGutenbergV2ApprovalBinding,
  hashGutenbergV2Value,
  type GutenbergV2StagedAsset,
  type GutenbergV2WordPressTransport
} from "@sitepilot/services";

import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL,
  E2E_REGISTRATION_CODE
} from "./config.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EXACT_TEST_URL = "https://test.localhost:8890/";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function login(): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${E2E_BASE_URL}wp-login.php`, {
    waitUntil: "domcontentloaded"
  });
  await page.locator("#user_login").fill(E2E_ADMIN_USERNAME);
  await page.locator("#user_pass").fill(E2E_ADMIN_PASSWORD);
  await page.locator("#wp-submit").click();
  await page.waitForURL(/\/wp-admin\//, { timeout: 30_000 });
  await page.close();
  return context;
}

async function registrationCode(): Promise<string> {
  const configured = E2E_REGISTRATION_CODE.trim();
  const context = await login();
  try {
    const page = await context.newPage();
    await page.goto(
      `${E2E_BASE_URL}wp-admin/options-general.php?page=sitepilot`,
      {
        waitUntil: "domcontentloaded"
      }
    );
    const code = (await page.locator("code").allTextContents())
      .map((value) => value.trim())
      .find((value) => /^[A-Za-z0-9]{16,}$/.test(value));
    return code ?? configured;
  } finally {
    await context.browser()?.close();
  }
}

async function registerTestClient(): Promise<{
  siteId: string;
  clientId: string;
  secret: Buffer;
}> {
  const protocolResponse = await fetch(
    `${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`
  );
  assert(
    protocolResponse.ok,
    `Protocol endpoint failed with HTTP ${protocolResponse.status}.`
  );
  const protocol = (await protocolResponse.json()) as {
    protocol_version?: unknown;
  };
  assert(
    typeof protocol.protocol_version === "string",
    "Protocol endpoint omitted protocol_version."
  );

  const siteId = randomUUID();
  const clientId = `sitepilot-v2-e2e-${randomUUID()}`;
  const secret = randomBytes(32);
  const response = await fetch(`${E2E_BASE_URL}wp-json/sitepilot/v1/register`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      registrationCode: await registrationCode(),
      siteId,
      workspaceId: "sitepilot-v2-e2e",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: clientId,
      wordpressUsername: E2E_ADMIN_USERNAME,
      protocolVersion: protocol.protocol_version,
      siteName: "SitePilot v2 E2E",
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

function createPlan(
  siteId: string,
  title: string,
  staged: GutenbergV2StagedAsset
): GutenbergV2BlockPlan {
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "create_draft",
    target: { postType: "post" },
    postFields: {
      title,
      excerpt: 'Ampersands &, straight "quotes", and Unicode — café / 你好.',
      status: "draft"
    },
    blocks: [
      {
        ref: "heading-1",
        name: "core/heading",
        attributes: { content: "Native Gutenberg v2", level: 2 },
        children: []
      },
      {
        ref: "paragraph-1",
        name: "core/paragraph",
        attributes: {
          content:
            'Fish & Chips, "quoted text", apostrophe\'s byte, emoji 🧭, and 你好.'
        },
        children: []
      },
      {
        ref: "group-1",
        name: "core/group",
        attributes: { layout: { type: "constrained" } },
        children: [
          {
            ref: "columns-1",
            name: "core/columns",
            attributes: {},
            children: [
              {
                ref: "column-1",
                name: "core/column",
                attributes: {},
                children: [
                  {
                    ref: "column-paragraph-1",
                    name: "core/paragraph",
                    attributes: { content: "First native column." },
                    children: []
                  }
                ]
              },
              {
                ref: "column-2",
                name: "core/column",
                attributes: {},
                children: [
                  {
                    ref: "column-paragraph-2",
                    name: "core/paragraph",
                    attributes: { content: "Second native column." },
                    children: []
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        ref: "list-1",
        name: "core/list",
        attributes: { ordered: false },
        children: [
          {
            ref: "list-item-1",
            name: "core/list-item",
            attributes: { content: "First native item." },
            children: []
          },
          {
            ref: "list-item-2",
            name: "core/list-item",
            attributes: { content: "Second native item." },
            children: []
          }
        ]
      },
      {
        ref: "buttons-1",
        name: "core/buttons",
        attributes: { layout: { type: "flex", justifyContent: "left" } },
        children: [
          {
            ref: "button-1",
            name: "core/button",
            attributes: {
              text: "Native action",
              url: "https://example.com/native"
            },
            children: []
          }
        ]
      },
      {
        ref: "quote-1",
        name: "core/quote",
        attributes: { citation: "Native citation" },
        children: [
          {
            ref: "quote-paragraph-1",
            name: "core/paragraph",
            attributes: { content: "A native quoted statement." },
            children: []
          }
        ]
      },
      {
        ref: "spacer-1",
        name: "core/spacer",
        attributes: { height: "32px" },
        children: []
      },
      {
        ref: "table-1",
        name: "core/table",
        attributes: {
          head: [
            {
              cells: [
                { content: "Column A", tag: "th" },
                { content: "Column B", tag: "th" }
              ]
            }
          ],
          body: [
            {
              cells: [
                { content: "Fish & Chips", tag: "td" },
                { content: "你好", tag: "td" }
              ]
            }
          ],
          caption: "Native table caption",
          hasFixedLayout: true
        },
        children: []
      },
      {
        ref: "pullquote-1",
        name: "core/pullquote",
        attributes: {
          value: "Native pullquote text.",
          citation: "Pullquote citation"
        },
        children: []
      },
      {
        ref: "image-1",
        name: "core/image",
        attributes: {
          mediaRef: "A-image",
          alt: "V2 image fixture",
          caption: "Image caption & Unicode 你好",
          sizeSlug: "full",
          linkDestination: "none"
        },
        children: []
      },
      {
        ref: "media-text-1",
        name: "core/media-text",
        attributes: {
          mediaRef: "a-media",
          mediaAlt: "V2 image fixture",
          mediaPosition: "right",
          mediaWidth: 40,
          isStackedOnMobile: true
        },
        children: [
          {
            ref: "media-paragraph-1",
            name: "core/paragraph",
            attributes: { content: "Native media text body." },
            children: []
          }
        ]
      }
    ],
    media: [
      {
        ref: "A-image",
        source: {
          kind: "staged_asset",
          stagedAssetId: staged.stagedAssetId,
          checksum: staged.checksum,
          mediaType: staged.mediaType,
          byteLength: staged.byteLength
        },
        alt: "V2 image fixture",
        caption: "Image caption & Unicode 你好"
      },
      {
        ref: "a-media",
        source: {
          kind: "staged_asset",
          stagedAssetId: staged.stagedAssetId,
          checksum: staged.checksum,
          mediaType: staged.mediaType,
          byteLength: staged.byteLength
        },
        alt: "V2 image fixture"
      }
    ]
  });
}

function countPlanNodes(plan: GutenbergV2BlockPlan): number {
  const count = (nodes: GutenbergV2BlockNode[]): number =>
    nodes.reduce((total, node) => total + 1 + count(node.children), 0);
  if ("blocks" in plan) return count(plan.blocks);
  return plan.operations.reduce((total, operation) => {
    if (operation.type === "insert_blocks")
      return total + count(operation.blocks);
    if (operation.type === "edit_block")
      return total + count([operation.replacement]);
    return total;
  }, 0);
}

function libraryReusePlan(
  plan: GutenbergV2BlockPlan,
  mapping: GutenbergV2MediaMapping[],
  title: string
): GutenbergV2BlockPlan {
  assert(
    plan.operation === "create_draft",
    "Library reuse fixture requires a create plan."
  );
  const byRef = new Map(mapping.map((entry) => [entry.ref, entry]));
  return gutenbergV2BlockPlanSchema.parse({
    ...plan,
    planId: `plan-${randomUUID()}`,
    postFields: { ...plan.postFields, title },
    media: plan.media.map((entry) => {
      const bound = byRef.get(entry.ref);
      assert(bound, `Media binding omitted ${entry.ref}.`);
      return {
        ...entry,
        source: {
          kind: "library_attachment",
          attachmentId: bound.attachmentId,
          checksum: bound.finalChecksum
        }
      };
    })
  });
}

function buttonWidthProbePlan(siteId: string): GutenbergV2BlockPlan {
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "create_draft",
    target: { postType: "post" },
    postFields: {
      title: "AUTOMATED-TEST-V2-BUTTON-WIDTH-PROBE",
      status: "draft"
    },
    blocks: [
      {
        ref: "buttons-1",
        name: "core/buttons",
        attributes: {},
        children: [
          {
            ref: "button-1",
            name: "core/button",
            attributes: {
              text: "Destination drops width",
              url: "https://example.com/",
              width: 50
            },
            children: []
          }
        ]
      }
    ],
    media: []
  });
}

async function runButtonWidthProbe(
  worker: PlaywrightGutenbergV2Worker,
  siteId: string
): Promise<{
  outcome: "preserved" | "dropped";
  disposition: "candidate_valid" | "content_changed";
  issue?: { code: string; blockName?: string; message: string };
}> {
  const plan = buttonWidthProbePlan(siteId);
  const capabilities = await worker.discoverCapabilities({
    siteId,
    postType: "post"
  });
  try {
    await worker.compile({
      candidateId: `button-width-probe-${randomUUID()}`,
      plan,
      capabilities
    });
    return { outcome: "preserved", disposition: "candidate_valid" };
  } catch (error) {
    if (!(error instanceof GutenbergV2WorkerError)) throw error;
    const changed = error.issues.find(
      (entry) =>
        entry.code === "content_changed" && entry.blockName === "core/button"
    );
    if (!changed || error.code !== "content_changed") throw error;
    return {
      outcome: "dropped",
      disposition: "content_changed",
      issue: {
        code: changed.code,
        ...(changed.blockName ? { blockName: changed.blockName } : {}),
        message: changed.message
      }
    };
  }
}

function capabilityEvidence(snapshot: GutenbergV2EditorCapabilitySnapshot) {
  const expectedAuthorBlocks = GUTENBERG_V2_SUPPORT_MATRIX.filter(
    (entry) => entry.mode === "author"
  ).map((entry) => entry.name);
  const authorable = snapshot.blocks
    .filter(
      (block) =>
        block.registered &&
        block.allowed &&
        block.lock === "none" &&
        block.v2Support === "author"
    )
    .map((block) => block.name)
    .sort();
  const expected = [...expectedAuthorBlocks].sort();
  assert(
    expected.length > 0,
    "The release authoring matrix must contain at least one block type."
  );
  assert(
    JSON.stringify(authorable) === JSON.stringify(expected),
    `Destination authoring matrix changed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(authorable)}.`
  );

  return {
    fingerprint: snapshot.fingerprint,
    wordpressVersion: snapshot.wordpressVersion,
    ...(snapshot.gutenbergVersion
      ? { gutenbergVersion: snapshot.gutenbergVersion }
      : {}),
    context: {
      postType: snapshot.context.postType,
      theme: snapshot.context.theme,
      pluginFingerprint: snapshot.context.pluginFingerprint,
      editorSettingsFingerprint: snapshot.context.editorSettingsFingerprint
    },
    registeredBlockCount: snapshot.blocks.filter((block) => block.registered)
      .length,
    allowedBlockCount: snapshot.blocks.filter((block) => block.allowed).length,
    authorable,
    fixtureGated: snapshot.blocks
      .filter((block) =>
        ["core/latest-posts", "acf/container"].includes(block.name)
      )
      .map((block) => ({
        name: block.name,
        registered: block.registered,
        allowed: block.allowed,
        v2Support: block.v2Support,
        dynamic: block.dynamic,
        lock: block.lock,
        attributeSchemaHash: block.attributeSchemaHash
      }))
  };
}

function scopedInsertPlan(
  siteId: string,
  source: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>
): GutenbergV2BlockPlan {
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "apply_operations",
    target: {
      postId: source.postId,
      postType: source.postType,
      sourceRevision: source.revision,
      sourceContentHash: source.contentHash,
      expectedFields: {}
    },
    operations: [
      {
        id: "insert-root-heading",
        type: "insert_blocks",
        parent: { path: [], expectedFingerprint: source.blockTreeFingerprint },
        index: source.blockIndex.filter((entry) => entry.path.length === 1)
          .length,
        blocks: [
          {
            ref: "scoped-heading-1",
            name: "core/heading",
            attributes: { content: "Scoped native insertion", level: 3 },
            children: []
          }
        ]
      }
    ],
    media: []
  });
}

function historicalCreatePlan(siteId: string): GutenbergV2BlockPlan {
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "create_draft",
    target: { postType: "post" },
    postFields: {
      title: `AUTOMATED-TEST-V2-HISTORICAL-${randomUUID()}`,
      status: "draft"
    },
    blocks: [
      {
        ref: "history-paragraph-1",
        name: "core/paragraph",
        attributes: { content: "Historical paragraph one." },
        children: []
      },
      {
        ref: "history-paragraph-2",
        name: "core/paragraph",
        attributes: { content: "Historical paragraph two." },
        children: []
      },
      {
        ref: "history-paragraph-3",
        name: "core/paragraph",
        attributes: { content: "Historical paragraph three." },
        children: []
      }
    ],
    media: []
  });
}

function historicalTarget(
  source: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>
) {
  return {
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
  };
}

function historicalInsertPlan(
  siteId: string,
  source: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>,
  stage: "heading" | "image",
  staged: GutenbergV2StagedAsset
): GutenbergV2BlockPlan {
  assert(source.blockIndex.length > 0, "Historical workflow source is empty.");
  const rootFingerprint = source.blockTreeFingerprint;
  const heading = {
    ref: "history-heading",
    name: "core/heading" as const,
    attributes: { content: "Historical heading", level: 2 },
    children: []
  };
  const image = {
    ref: "history-image-block",
    name: "core/image" as const,
    attributes: {
      mediaRef: "history-image",
      alt: "Historical workflow image",
      sizeSlug: "large" as const,
      linkDestination: "none" as const
    },
    children: []
  };
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "apply_operations",
    target: historicalTarget(source),
    operations: [
      {
        id: `history-insert-${stage}`,
        type: "insert_blocks",
        parent: { path: [], expectedFingerprint: rootFingerprint },
        index: stage === "heading" ? 2 : 3,
        blocks: [stage === "heading" ? heading : image]
      }
    ],
    media:
      stage === "image"
        ? [
            {
              ref: "history-image",
              source: {
                kind: "staged_asset",
                stagedAssetId: staged.stagedAssetId,
                checksum: staged.checksum,
                mediaType: staged.mediaType,
                byteLength: staged.byteLength
              },
              alt: "Historical workflow image"
            }
          ]
        : []
  });
}

function historicalHeadingEditPlan(
  siteId: string,
  source: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>
): GutenbergV2BlockPlan {
  const heading = source.blockIndex.find(
    (entry) => entry.path.length === 1 && entry.name === "core/heading"
  );
  assert(heading, "Historical workflow heading was not found.");
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "apply_operations",
    target: historicalTarget(source),
    operations: [
      {
        id: "history-edit-heading-level",
        type: "edit_block",
        target: {
          path: heading.path,
          expectedFingerprint: heading.fingerprint
        },
        replacement: {
          ref: "history-heading-h3",
          name: "core/heading",
          attributes: { content: "Historical heading", level: 3 },
          children: []
        }
      }
    ],
    media: []
  });
}

async function executeHistoricalPlan(
  service: GutenbergV2ContentService,
  plan: GutenbergV2BlockPlan
): Promise<{ postId: number; mediaIds: number[] }> {
  const executionId = `history-${randomUUID()}`;
  let candidate: GutenbergV2CompiledCandidate;
  try {
    candidate = await service.compileCandidate({
      executionId,
      idempotencyKey: `history-${randomUUID()}`,
      plan
    });
  } catch (error) {
    if (error instanceof GutenbergV2ServiceError) {
      console.error(`Compile failed: ${boundedServiceDiagnostic(error)}`);
    }
    throw error;
  }
  await service.recordApproval({ executionId, approval: approval(candidate) });
  const result = await service.executeApprovedCandidate({ executionId });
  assert(
    result.state === "succeeded" && result.postId,
    `Historical workflow execution ended in ${result.state}.`
  );
  return { postId: result.postId, mediaIds: result.createdMediaIds };
}

function paragraphBlockBytes(rawContent: string): string[] {
  return (
    rawContent.match(
      /<!-- wp:paragraph(?:\s[^>]*)?-->[\s\S]*?<!-- \/wp:paragraph -->/g
    ) ?? []
  );
}

function serializedHeadingLevels(rawContent: string): number[] {
  const levels: number[] = [];
  for (const match of rawContent.matchAll(
    /<!-- wp:heading(?:\s+(\{[\s\S]*?\}))?\s*-->/g
  )) {
    const attributes = match[1] === undefined ? {} : JSON.parse(match[1]);
    levels.push(typeof attributes.level === "number" ? attributes.level : 2);
  }
  return levels;
}

function assertHistoricalPreservation(
  before: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>,
  after: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>,
  expectedParagraphs: string[]
): void {
  const beforeParagraphs = paragraphBlockBytes(before.rawContent);
  assert(
    beforeParagraphs.length === expectedParagraphs.length,
    `Historical source had ${beforeParagraphs.length} paragraph bytes; expected ${expectedParagraphs.length}.`
  );
  assert(
    expectedParagraphs.every((bytes) => after.rawContent.includes(bytes)),
    "Historical workflow changed an unaffected paragraph's serialized bytes."
  );
  const beforeRoots = before.blockIndex.filter(
    (entry) => entry.path.length === 1
  );
  const afterRoots = after.blockIndex.filter(
    (entry) => entry.path.length === 1
  );
  for (const [index, paragraph] of beforeRoots
    .filter((entry) => entry.name === "core/paragraph")
    .entries()) {
    const matching = after.blockIndex.find(
      (entry) =>
        entry.name === "core/paragraph" &&
        entry.fingerprint === paragraph.fingerprint
    );
    assert(matching, `Historical paragraph ${index + 1} fingerprint changed.`);
  }
  assert(
    afterRoots.length >= beforeRoots.length,
    "Historical workflow unexpectedly removed a root block."
  );
}

async function runHistoricalWorkflow(
  service: GutenbergV2ContentService,
  worker: PlaywrightGutenbergV2Worker,
  siteId: string,
  staged: GutenbergV2StagedAsset
): Promise<{
  postId: number;
  mediaIds: number[];
  paragraphs: number;
  nativeSaveReopen: { blockCount: number; allValid: boolean };
}> {
  const created = await executeHistoricalPlan(
    service,
    historicalCreatePlan(siteId)
  );
  let source = await worker.readSource({
    executionId: `history-source-${randomUUID()}`,
    siteId,
    postType: "post",
    postId: created.postId
  });
  const paragraphs = paragraphBlockBytes(source.rawContent);
  assert(
    paragraphs.length === 3,
    "Historical fixture did not create 3 paragraphs."
  );
  const initialSource = source;
  let mediaIds: number[] = [];

  await executeHistoricalPlan(
    service,
    historicalInsertPlan(siteId, source, "heading", staged)
  );
  source = await worker.readSource({
    executionId: `history-source-${randomUUID()}`,
    siteId,
    postType: "post",
    postId: created.postId
  });
  assertHistoricalPreservation(initialSource, source, paragraphs);

  const imageExecution = await executeHistoricalPlan(
    service,
    historicalInsertPlan(siteId, source, "image", staged)
  );
  mediaIds = imageExecution.mediaIds;
  source = await worker.readSource({
    executionId: `history-source-${randomUUID()}`,
    siteId,
    postType: "post",
    postId: created.postId
  });
  assertHistoricalPreservation(initialSource, source, paragraphs);

  await executeHistoricalPlan(
    service,
    historicalHeadingEditPlan(siteId, source)
  );
  source = await worker.readSource({
    executionId: `history-source-${randomUUID()}`,
    siteId,
    postType: "post",
    postId: created.postId
  });
  assertHistoricalPreservation(initialSource, source, paragraphs);
  assert(
    source.blockIndex.some(
      (entry) => entry.name === "core/heading" && entry.path.length === 1
    ),
    "Historical heading was not retained after the H2 to H3 edit."
  );
  assert(
    serializedHeadingLevels(source.rawContent).includes(3),
    "Historical heading did not persist its requested H3 level in serialized Gutenberg attributes."
  );
  const nativeSaveReopen = await nativeSaveAndReopen(created.postId);
  assert(
    nativeSaveReopen.allValid && nativeSaveReopen.blockCount === 5,
    `Historical workflow reopen returned ${nativeSaveReopen.blockCount}/5 valid blocks.`
  );
  return {
    postId: created.postId,
    mediaIds,
    paragraphs: paragraphs.length,
    nativeSaveReopen
  };
}

// ---- Blocks added after the first release -----------------------------------

const EMBED_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const CODE_TEXT = "const total = items\n  .filter((item) =&gt; item.ok)\n  .length;";

function stagedMedia(ref: string, staged: GutenbergV2StagedAsset, alt: string) {
  return {
    ref,
    source: {
      kind: "staged_asset" as const,
      stagedAssetId: staged.stagedAssetId,
      checksum: staged.checksum,
      mediaType: staged.mediaType,
      byteLength: staged.byteLength
    },
    alt
  };
}

function newBlocksPlan(
  siteId: string,
  staged: GutenbergV2StagedAsset,
  video: GutenbergV2StagedAsset,
  embedUrl = EMBED_URL
): GutenbergV2BlockPlan {
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "create_draft",
    target: { postType: "post" },
    postFields: {
      title: `AUTOMATED-TEST-V2-NEW-BLOCKS-${randomUUID()}`,
      status: "draft"
    },
    blocks: [
      {
        ref: "cover-image",
        name: "core/cover",
        attributes: {
          mediaRef: "cover-media",
          alt: "",
          dimRatio: 50,
          minHeight: 420,
          minHeightUnit: "px",
          align: "full"
        },
        children: [
          {
            ref: "cover-heading",
            name: "core/heading",
            attributes: { content: "Cover heading", level: 2 },
            children: []
          }
        ]
      },
      {
        ref: "cover-colour",
        name: "core/cover",
        attributes: { customOverlayColor: "#1e3a5f", dimRatio: 100 },
        children: [
          {
            ref: "cover-colour-text",
            name: "core/paragraph",
            attributes: { content: "Colour-only cover." },
            children: []
          }
        ]
      },
      {
        ref: "separator-1",
        name: "core/separator",
        attributes: { className: "is-style-wide" },
        children: []
      },
      {
        ref: "details-1",
        name: "core/details",
        attributes: { summary: "What is included?" },
        children: [
          {
            ref: "details-body",
            name: "core/paragraph",
            attributes: { content: "Everything in the hidden panel." },
            children: []
          }
        ]
      },
      {
        ref: "code-1",
        name: "core/code",
        attributes: { content: CODE_TEXT },
        children: []
      },
      {
        ref: "pre-1",
        name: "core/preformatted",
        attributes: { content: "Line one\n  indented line two" },
        children: []
      },
      {
        ref: "gallery-1",
        name: "core/gallery",
        attributes: { columns: 2, linkTo: "none" },
        children: [
          {
            ref: "gallery-image-1",
            name: "core/image",
            attributes: {
              mediaRef: "gallery-a",
              alt: "Gallery image one",
              sizeSlug: "large",
              linkDestination: "none"
            },
            children: []
          },
          {
            ref: "gallery-image-2",
            name: "core/image",
            attributes: {
              mediaRef: "gallery-b",
              alt: "Gallery image two",
              sizeSlug: "large",
              linkDestination: "none"
            },
            children: []
          }
        ]
      },
      {
        ref: "embed-1",
        name: "core/embed",
        attributes: {
          url: embedUrl,
          providerNameSlug: "youtube",
          type: "video",
          responsive: true,
          className: "wp-embed-aspect-16-9 wp-has-aspect-ratio"
        },
        children: []
      },
      {
        ref: "video-1",
        name: "core/video",
        attributes: {
          mediaRef: "video-media",
          caption: "Uploaded test video",
          muted: true,
          playsInline: true
        },
        children: []
      }
    ],
    media: [
      stagedMedia("video-media", video, "Test video"),
      stagedMedia("cover-media", staged, "Cover background"),
      stagedMedia("gallery-a", staged, "Gallery image one"),
      stagedMedia("gallery-b", staged, "Gallery image two")
    ]
  });
}

async function runNewBlocksWorkflow(
  service: GutenbergV2ContentService,
  worker: PlaywrightGutenbergV2Worker,
  siteId: string,
  staged: GutenbergV2StagedAsset,
  video: GutenbergV2StagedAsset
): Promise<{
  postId: number;
  blockCount: number;
  nativeSaveReopen: { blockCount: number; allValid: boolean };
  bytesUnchangedByNativeSave: boolean;
  codeEdit: string;
  unavailableEmbed: string;
}> {
  const unavailableEmbed = await expectCompileRejection(
    service,
    newBlocksPlan(
      siteId,
      staged,
      video,
      "https://www.youtube.com/watch?v=SitePilot00"
    ),
    "media_changed",
    "An unavailable YouTube video"
  );
  const plan = newBlocksPlan(siteId, staged, video);
  const created = await executeHistoricalPlan(service, plan);
  const read = () =>
    worker.readSource({
      executionId: `new-blocks-source-${randomUUID()}`,
      siteId,
      postType: "post",
      postId: created.postId
    });
  let source = await read();
  const raw = source.rawContent;
  for (const [label, pattern] of [
    ["cover image", /<!-- wp:cover \{[^}]*"url":"https?:[^"]+"/],
    ["colour cover", /"customOverlayColor":"#1e3a5f"/],
    ["separator", /<!-- wp:separator \{"className":"is-style-wide"\} -->/],
    ["details", /<summary>What is included\?<\/summary>/],
    ["code line breaks", /<code>const total = items\n {2}\.filter/],
    // Preformatted text stores line breaks as <br>; code keeps "\n".
    ["preformatted line breaks", /<pre class="wp-block-preformatted">Line one<br> {2}indented/],
    ["gallery", /<!-- wp:gallery \{"columns":2,"linkTo":"none"\} -->/],
    ["video", /<!-- wp:video \{"id":\d+\} -->\n?<figure class="wp-block-video"><video [^>]*src="https?:[^"]+\.mp4"/],
    ["embed", new RegExp(`<!-- wp:embed \\{"url":"${EMBED_URL.replace(/[.?]/g, "\\$&")}","type":"video","providerNameSlug":"youtube","responsive":true`)]
  ] as const) {
    assert(
      pattern.test(raw),
      `${label} was not persisted as expected: ${raw.slice(raw.indexOf("<!-- wp:embed"), raw.indexOf("<!-- wp:embed") + 2500)}`
    );
  }
  const blockCount = countPlanNodes(plan);
  assert(
    source.blockIndex.length === blockCount,
    `New-block draft has ${source.blockIndex.length}/${blockCount} blocks.`
  );

  const nativeSaveReopen = await nativeSaveAndReopen(created.postId);
  assert(
    nativeSaveReopen.allValid && nativeSaveReopen.blockCount === blockCount,
    `New blocks reopened as ${nativeSaveReopen.blockCount}/${blockCount} (allValid=${nativeSaveReopen.allValid}).`
  );
  const afterSave = await read();
  const bytesUnchangedByNativeSave = afterSave.contentHash === source.contentHash;

  // A scoped edit keeps the code block's line breaks and leaves the rest alone.
  source = afterSave;
  const code = source.blockIndex.find((entry) => entry.name === "core/code");
  assert(code, "The code block is missing.");
  await executeHistoricalPlan(
    service,
    gutenbergV2BlockPlanSchema.parse({
      schemaVersion: "sitepilot.block-plan/v2",
      planId: `plan-${randomUUID()}`,
      siteId,
      operation: "apply_operations",
      target: historicalTarget(source),
      operations: [
        {
          id: "edit-code",
          type: "edit_block",
          target: { path: code.path, expectedFingerprint: code.fingerprint },
          replacement: {
            ref: "code-edited",
            name: "core/code",
            attributes: { content: "line 1\nline 2\n  line 3" },
            children: []
          }
        }
      ],
      media: []
    })
  );
  const edited = await read();
  assert(
    edited.rawContent.includes("<code>line 1\nline 2\n  line 3</code>"),
    `The edited code block lost its line breaks: ${edited.rawContent.slice(0, 3000)}`
  );
  const untouched = source.rawContent.split("<!-- wp:code")[0]!;
  assert(
    edited.rawContent.startsWith(untouched),
    "The code edit changed blocks before it."
  );
  return {
    postId: created.postId,
    blockCount,
    nativeSaveReopen,
    bytesUnchangedByNativeSave,
    codeEdit: "succeeded",
    unavailableEmbed
  };
}

// ---- Preservation of blocks v2 cannot author ---------------------------------

const PRESERVED_HTML =
  '<!-- wp:html --><div class="sitepilot-e2e-html">Custom <b>HTML</b></div><!-- /wp:html -->';
const PRESERVED_ARCHIVES = "<!-- wp:archives /-->";
const PRESERVED_MISSING =
  '<!-- wp:sitepilot-e2e/inactive-widget {"id":7} /-->';
const PRESERVED_SOCIAL =
  '<!-- wp:social-links --><ul class="wp-block-social-links"><!-- wp:social-link {"url":"https://wordpress.org","service":"wordpress"} /--></ul><!-- /wp:social-links -->';
const CLOSING_PARAGRAPH =
  "<!-- wp:paragraph --><p>Closing paragraph stays byte-identical.</p><!-- /wp:paragraph -->";

function preservationSourceContent(): string {
  return [
    "<!-- wp:paragraph --><p>Intro paragraph to remove.</p><!-- /wp:paragraph -->",
    PRESERVED_HTML,
    '<!-- wp:group {"layout":{"type":"constrained"}} -->\n<div class="wp-block-group"><!-- wp:paragraph --><p>Inside the group.</p><!-- /wp:paragraph -->\n\n' +
      PRESERVED_ARCHIVES +
      '\n\n<!-- wp:paragraph {"fontSize":"large"} -->\n<p class="has-large-font-size">Styled paragraph.</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->',
    PRESERVED_MISSING,
    PRESERVED_SOCIAL,
    CLOSING_PARAGRAPH
  ].join("\n\n");
}

async function createRawDraft(title: string, content: string): Promise<number> {
  const context = await login();
  try {
    const page = await context.newPage();
    await page.goto(`${E2E_BASE_URL}wp-admin/post-new.php`, {
      waitUntil: "domcontentloaded"
    });
    const result = await page.evaluate(
      async ({ postTitle, postContent }) => {
        const nonce = (
          globalThis as unknown as { wpApiSettings?: { nonce?: string } }
        ).wpApiSettings?.nonce;
        if (!nonce) return { status: 0, body: "missing nonce", id: 0 };
        const response = await fetch("/wp-json/wp/v2/posts", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-wp-nonce": nonce },
          body: JSON.stringify({
            title: postTitle,
            content: postContent,
            status: "draft"
          })
        });
        const body = await response.text();
        let id = 0;
        try {
          id = (JSON.parse(body) as { id?: number }).id ?? 0;
        } catch {
          id = 0;
        }
        return { status: response.status, body, id };
      },
      { postTitle: title, postContent: content }
    );
    assert(
      result.status >= 200 && result.status < 300 && result.id > 0,
      `Creating the preservation fixture failed with HTTP ${result.status}: ${result.body.slice(0, 300)}`
    );
    return result.id;
  } finally {
    await context.browser()?.close();
  }
}

type SourceSnapshot = Awaited<
  ReturnType<PlaywrightGutenbergV2Worker["readSource"]>
>;

function indexEntry(source: SourceSnapshot, path: number[]) {
  const entry = source.blockIndex.find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(path)
  );
  assert(
    entry,
    `Source block ${JSON.stringify(path)} is missing: ${JSON.stringify(source.blockIndex.map(({ path: p, name, role }) => ({ p, name, role })))} raw=${source.rawContent.slice(0, 900)}`
  );
  return entry;
}

function target(source: SourceSnapshot, path: number[]) {
  return { path, expectedFingerprint: indexEntry(source, path).fingerprint };
}

function rootTarget(source: SourceSnapshot) {
  return { path: [], expectedFingerprint: source.blockTreeFingerprint };
}

function preservationEditPlan(
  siteId: string,
  source: SourceSnapshot
): GutenbergV2BlockPlan {
  // Root: [0] intro, [1] html, [2] group, [3] inactive plugin block (parsed as
  // core/missing), [4] social links, [5] closing paragraph.
  assert(indexEntry(source, [1]).name === "core/html", "Expected core/html at [1].");
  assert(indexEntry(source, [2, 2]).name === "core/paragraph", "Expected the styled paragraph at [2,2].");
  assert(indexEntry(source, [1]).role === "preserved", "core/html must be reported as preserved.");
  assert(indexEntry(source, [3]).name === "core/missing", "Expected the inactive plugin block at [3].");
  assert(indexEntry(source, [4, 0]).role === "inside_preserved", "social-link must be inside a preserved block.");
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "apply_operations",
    target: historicalTarget(source),
    operations: [
      {
        id: "edit-styled",
        type: "edit_block",
        target: target(source, [2, 2]),
        replacement: {
          ref: "styled-edit",
          name: "core/paragraph",
          attributes: { content: "Styled paragraph, edited in place." },
          children: []
        }
      },
      {
        id: "insert-in-group",
        type: "insert_blocks",
        parent: target(source, [2]),
        index: 1,
        blocks: [
          {
            ref: "group-heading",
            name: "core/heading",
            attributes: { content: "Inserted before the archives", level: 3 },
            children: []
          }
        ]
      },
      {
        id: "move-html",
        type: "move_block",
        target: target(source, [1]),
        parent: rootTarget(source),
        index: 6
      },
      {
        id: "remove-intro",
        type: "remove_block",
        target: target(source, [0])
      }
    ],
    media: []
  });
}

async function expectCompileRejection(
  service: GutenbergV2ContentService,
  plan: GutenbergV2BlockPlan,
  expectedCode: string,
  label: string
): Promise<string> {
  try {
    await service.compileCandidate({
      executionId: `negative-${randomUUID()}`,
      idempotencyKey: `negative-${randomUUID()}`,
      plan
    });
  } catch (error) {
    if (error instanceof GutenbergV2ServiceError) {
      const codes = [error.code, ...error.issues.map((entry) => entry.code)];
      assert(
        codes.includes(expectedCode as GutenbergV2ServiceError["code"]),
        `${label} failed with ${boundedServiceDiagnostic(error)}, expected ${expectedCode}.`
      );
      return expectedCode;
    }
    throw error;
  }
  throw new Error(`${label} compiled, but it must be rejected with ${expectedCode}.`);
}

async function runPreservationWorkflow(
  service: GutenbergV2ContentService,
  worker: PlaywrightGutenbergV2Worker,
  siteId: string
): Promise<{
  postId: number;
  multiOperationEdit: string;
  rejected: string[];
  keptReplacement: string;
}> {
  const postId = await createRawDraft(
    `AUTOMATED-TEST-V2-PRESERVATION-${randomUUID()}`,
    preservationSourceContent()
  );
  const read = () =>
    worker.readSource({
      executionId: `preservation-source-${randomUUID()}`,
      siteId,
      postType: "post",
      postId
    });
  let source = await read();

  const rejected: string[] = [];
  // Editing inside a preserved block is refused.
  rejected.push(
    await expectCompileRejection(
      service,
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId,
        operation: "apply_operations",
        target: historicalTarget(source),
        operations: [
          { id: "inside", type: "remove_block", target: target(source, [4, 0]) }
        ],
        media: []
      }),
      "locked_structure",
      "Removing a block inside a preserved block"
    )
  );
  // A replacement that silently drops preserved blocks is refused.
  rejected.push(
    await expectCompileRejection(
      service,
      gutenbergV2BlockPlanSchema.parse({
        schemaVersion: "sitepilot.block-plan/v2",
        planId: `plan-${randomUUID()}`,
        siteId,
        operation: "replace_content",
        target: historicalTarget(source),
        blocks: [
          {
            ref: "only",
            name: "core/paragraph",
            attributes: { content: "Everything else is gone." },
            children: []
          }
        ],
        media: []
      }),
      "content_loss",
      "A replacement that drops preserved blocks"
    )
  );

  // Edit, insert, move and remove in one plan, all against the original tree.
  await executeHistoricalPlan(service, preservationEditPlan(siteId, source));
  source = await read();
  const raw = source.rawContent;
  for (const [label, bytes] of [
    ["core/html", PRESERVED_HTML],
    ["core/archives", PRESERVED_ARCHIVES],
    ["inactive plugin block", PRESERVED_MISSING],
    ["core/social-links", PRESERVED_SOCIAL],
    ["closing paragraph", CLOSING_PARAGRAPH]
  ] as const) {
    assert(raw.includes(bytes), `${label} bytes changed after the scoped edit.`);
  }
  assert(!raw.includes("Intro paragraph to remove."), "The removed intro survived.");
  assert(
    raw.includes("Styled paragraph, edited in place.") &&
      /<!-- wp:paragraph \{"fontSize":"large"\} -->/.test(raw),
    `The edited paragraph lost its font size: ${raw.slice(0, 1200)}`
  );
  assert(
    raw.indexOf("Inserted before the archives") < raw.indexOf(PRESERVED_ARCHIVES) &&
      raw.indexOf("Inside the group.") < raw.indexOf("Inserted before the archives"),
    "The inserted heading is not between the group paragraph and the archives."
  );
  assert(
    raw.lastIndexOf(PRESERVED_HTML) > raw.indexOf(CLOSING_PARAGRAPH),
    "The HTML block was not moved to the end."
  );

  // The replacement keeps neither the inactive plugin block nor lists it for
  // deletion, so it must be refused rather than drop it.
  rejected.push(
    await expectCompileRejection(
      service,
      keptReplacementPlan(siteId, source),
      "content_loss",
      "A replacement that drops an inactive plugin block"
    )
  );

  // Without that widget, the same replacement keeps the preserved blocks
  // byte-for-byte and deletes the group (and its archives) on purpose.
  const replacePostId = await createRawDraft(
    `AUTOMATED-TEST-V2-KEPT-REPLACEMENT-${randomUUID()}`,
    preservationSourceContent().replace(`${PRESERVED_MISSING}\n\n`, "")
  );
  const replaceSource = await worker.readSource({
    executionId: `preservation-source-${randomUUID()}`,
    siteId,
    postType: "post",
    postId: replacePostId
  });
  await executeHistoricalPlan(
    service,
    keptReplacementPlan(siteId, replaceSource)
  );
  const replaced = await worker.readSource({
    executionId: `preservation-source-${randomUUID()}`,
    siteId,
    postType: "post",
    postId: replacePostId
  });
  assert(
    replaced.rawContent.includes(PRESERVED_HTML) &&
      replaced.rawContent.includes(PRESERVED_SOCIAL) &&
      replaced.rawContent.includes("A new introduction.") &&
      !replaced.rawContent.includes(PRESERVED_ARCHIVES) &&
      !replaced.rawContent.includes("Inside the group."),
    `The kept replacement did not keep exactly the requested blocks: ${replaced.rawContent.slice(0, 1500)}`
  );
  return {
    postId,
    multiOperationEdit: "succeeded",
    rejected,
    keptReplacement: `succeeded on post ${replacePostId}`
  };
}

function keptReplacementPlan(
  siteId: string,
  source: SourceSnapshot
): GutenbergV2BlockPlan {
  const root = (name: string) => {
    const entry = source.blockIndex.find(
      (candidate) => candidate.path.length === 1 && candidate.name === name
    );
    assert(entry, `Preservation fixture lost its root ${name}.`);
    return entry;
  };
  const html = root("core/html");
  const social = root("core/social-links");
  const group = root("core/group");
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "replace_content",
    target: historicalTarget(source),
    removedSourceBlocks: [
      { path: group.path, expectedFingerprint: group.fingerprint }
    ],
    blocks: [
      {
        ref: "new-intro",
        name: "core/paragraph",
        attributes: { content: "A new introduction." },
        children: []
      },
      {
        ref: "keep-html",
        name: "sitepilot/source-block",
        attributes: { path: html.path, expectedFingerprint: html.fingerprint },
        children: []
      },
      {
        ref: "wrapper",
        name: "core/group",
        attributes: {},
        children: [
          {
            ref: "keep-social",
            name: "sitepilot/source-block",
            attributes: {
              path: social.path,
              expectedFingerprint: social.fingerprint
            },
            children: []
          }
        ]
      }
    ],
    media: []
  });
}

function replacementPlan(
  siteId: string,
  source: Awaited<ReturnType<PlaywrightGutenbergV2Worker["readSource"]>>,
  title: string
): GutenbergV2BlockPlan {
  return gutenbergV2BlockPlanSchema.parse({
    schemaVersion: "sitepilot.block-plan/v2",
    planId: `plan-${randomUUID()}`,
    siteId,
    operation: "replace_content",
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
    postFields: { title },
    blocks: [
      {
        ref: "replacement-1",
        name: "core/paragraph",
        attributes: {
          content: "Replacement content verified in a fresh native editor."
        },
        children: []
      }
    ],
    media: []
  });
}

function approval(
  candidate: GutenbergV2CompiledCandidate
): GutenbergV2Approval {
  const now = new Date();
  return {
    schemaVersion: "sitepilot.approval/v2",
    approvalId: `approval-${randomUUID()}`,
    approverId: "sitepilot-v2-e2e",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
}

function boundedServiceDiagnostic(error: GutenbergV2ServiceError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message.slice(0, 500),
    issues: error.issues.slice(0, 10).map((entry) => ({
      code: entry.code,
      blockName: entry.blockName,
      blockPath: entry.blockPath,
      planRef: entry.planRef,
      message: entry.message.slice(0, 300),
      expected: entry.expected?.slice(0, 500),
      actual: entry.actual?.slice(0, 500)
    }))
  });
}

async function assertReadOnlySession(
  sessionClient: WordPressEditorSessionClient,
  siteId: string,
  unrelatedPostId: number
): Promise<void> {
  const session = await sessionClient.createSession({
    schemaVersion: "sitepilot.editor-session-request/v2",
    executionId: `restriction-${randomUUID()}`,
    siteId,
    context: { postType: "post" }
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const bootstrap = await sessionClient.bootstrapSession(context, session);
    const editorPage = await context.newPage();
    const editor = await editorPage.goto(bootstrap.editorUrl, {
      waitUntil: "domcontentloaded"
    });
    assert(
      editor?.status() === 200,
      `Scoped editor failed with HTTP ${editor?.status() ?? 0}.`
    );
    await editorPage.waitForFunction(
      () =>
        typeof (
          globalThis as unknown as { wpApiSettings?: { nonce?: unknown } }
        ).wpApiSettings?.nonce === "string",
      undefined,
      { timeout: 30_000 }
    );
    const restNonce = await editorPage.evaluate(
      () =>
        (globalThis as unknown as { wpApiSettings: { nonce: string } })
          .wpApiSettings.nonce
    );
    const plugins = await context.request.get(
      `${E2E_BASE_URL}wp-admin/plugins.php`,
      { maxRedirects: 0 }
    );
    assert(
      plugins.status() === 403,
      `Scoped session reached plugins.php with HTTP ${plugins.status()}.`
    );
    if (unrelatedPostId !== session.context.postId) {
      const unrelated = await context.request.get(
        `${E2E_BASE_URL}wp-json/wp/v2/posts/${unrelatedPostId}?context=edit`,
        { headers: { "x-wp-nonce": restNonce }, maxRedirects: 0 }
      );
      assert(
        unrelated.status() === 403,
        `Scoped session read unrelated post with HTTP ${unrelated.status()}.`
      );
    }
    const autosave = await context.request.post(
      `${E2E_BASE_URL}wp-json/wp/v2/posts/${session.context.postId}/autosaves`,
      {
        data: { content: "must not save" },
        headers: { "x-wp-nonce": restNonce },
        maxRedirects: 0
      }
    );
    assert(
      autosave.status() === 403,
      `Scoped autosave returned HTTP ${autosave.status()}.`
    );

    const cookies = await context.cookies();
    const isLoggedInCookie = (name: string) =>
      name.startsWith("wordpress_logged_in_");
    const isAdminAuthCookie = (name: string) =>
      name.startsWith("wordpress_sec_") ||
      (/^wordpress_[a-f0-9]+$/i.test(name) && !isLoggedInCookie(name));
    assert(
      cookies.some((cookie) => isLoggedInCookie(cookie.name)),
      "Bootstrap omitted the native logged-in cookie."
    );
    assert(
      cookies.some((cookie) => isAdminAuthCookie(cookie.name)),
      "Bootstrap omitted the native admin auth cookie."
    );
    for (const retained of [
      cookies.filter((cookie) => !isLoggedInCookie(cookie.name)),
      cookies.filter((cookie) => !isAdminAuthCookie(cookie.name)),
      cookies.filter(
        (cookie) =>
          !isLoggedInCookie(cookie.name) && !isAdminAuthCookie(cookie.name)
      )
    ]) {
      await context.clearCookies();
      if (retained.length > 0) await context.addCookies(retained);
      const response = await context.request.get(
        `${E2E_BASE_URL}wp-admin/plugins.php`,
        { maxRedirects: 0 }
      );
      assert(
        response.status() !== 200,
        "A partial or absent native cookie set escaped the scoped session."
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function assertNativeNegativeControls(
  sessionClient: WordPressEditorSessionClient,
  siteId: string
): Promise<void> {
  const session = await sessionClient.createSession({
    schemaVersion: "sitepilot.editor-session-request/v2",
    executionId: `negative-controls-${randomUUID()}`,
    siteId,
    context: { postType: "post" }
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const bootstrap = await sessionClient.bootstrapSession(context, session);
    const page = await context.newPage();
    await page.goto(bootstrap.editorUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        typeof (
          globalThis as unknown as {
            sitepilotV2?: { ready?: unknown };
          }
        ).sitepilotV2?.ready === "function",
      undefined,
      { timeout: 30_000 }
    );
    const results = await page.evaluate(async (registeredSiteId) => {
      type NativeIssue = { code: string };
      type NativeReport = {
        outcome: string;
        issues: NativeIssue[];
        contentPreservation: { passed: boolean };
      };
      type CompileResult = {
        serializedContent: string;
        validation: NativeReport;
      };
      const bridge = (
        globalThis as unknown as {
          sitepilotV2: {
            ready(): Promise<unknown>;
            compile(input: {
              plan: Record<string, unknown>;
            }): Promise<CompileResult>;
            verify(input: {
              serializedContent: string;
              expectedSerializedContent: string;
              intent: Record<string, unknown>;
              mediaMapping: [];
            }): Promise<NativeReport>;
          };
        }
      ).sitepilotV2;
      await bridge.ready();
      const missingPlan = {
        schemaVersion: "sitepilot.block-plan/v2",
        planId: "negative-missing",
        siteId: registeredSiteId,
        operation: "create_draft",
        target: { postType: "post" },
        postFields: { title: "Missing block control", status: "draft" },
        blocks: [
          {
            ref: "missing-1",
            name: "core/missing",
            attributes: {},
            children: []
          }
        ],
        media: []
      };
      const missing = (await bridge.compile({ plan: missingPlan })).validation;
      const unsupportedPlan = {
        ...missingPlan,
        planId: "negative-unsupported",
        postFields: { title: "Unsupported block control", status: "draft" },
        blocks: [
          {
            ref: "latest-posts-1",
            name: "core/latest-posts",
            attributes: { postsToShow: 3 },
            children: []
          }
        ]
      };
      const unsupported = (await bridge.compile({ plan: unsupportedPlan }))
        .validation;
      const paragraphPlan = {
        ...missingPlan,
        planId: "negative-altered",
        postFields: { title: "Altered content control", status: "draft" },
        blocks: [
          {
            ref: "paragraph-1",
            name: "core/paragraph",
            attributes: { content: "Expected control text" },
            children: []
          }
        ]
      };
      const paragraph = await bridge.compile({ plan: paragraphPlan });
      const altered = await bridge.verify({
        serializedContent: paragraph.serializedContent.replace(
          "Expected control text",
          "Altered control text"
        ),
        expectedSerializedContent: paragraph.serializedContent,
        intent: paragraphPlan,
        mediaMapping: []
      });
      const headingPlan = {
        ...missingPlan,
        planId: "negative-malformed",
        postFields: { title: "Malformed markup control", status: "draft" },
        blocks: [
          {
            ref: "heading-1",
            name: "core/heading",
            attributes: { content: "Expected heading", level: 3 },
            children: []
          }
        ]
      };
      const heading = await bridge.compile({ plan: headingPlan });
      const malformed = await bridge.verify({
        serializedContent: heading.serializedContent.replace(
          '"level":3',
          '"level":2'
        ),
        expectedSerializedContent: heading.serializedContent,
        intent: headingPlan,
        mediaMapping: []
      });
      const escapedDelimiterPlan = {
        ...missingPlan,
        planId: "negative-escaped-delimiter",
        postFields: {
          title: "Escaped delimiter control",
          status: "draft"
        },
        blocks: [
          {
            ref: "paragraph-escaped-1",
            name: "core/paragraph",
            attributes: {
              content: "Expected paragraph"
            },
            innerHTML:
              "<p>Lorem ipsum dolor sit amet.&lt;!-- /wp:paragraph --&gt;\\n&lt;!-- wp:paragraph --&gt;Sed do eiusmod tempor incididunt ut labore.&lt;!-- /wp:paragraph --&gt;\\n&lt;!-- wp:heading --&gt;New heading!&lt;!-- /wp:heading --&gt;\\n&lt;!-- wp:paragraph --&gt;Ut enim ad minim veniam.&lt;!-- /wp:paragraph --&gt;</p>",
            children: []
          }
        ]
      };
      const escapedDelimiter = (
        await bridge.compile({ plan: escapedDelimiterPlan })
      ).validation;
      return { missing, unsupported, altered, malformed, escapedDelimiter };
    }, siteId);
    const controls = [
      { name: "missing", report: results.missing, code: "missing_block" },
      {
        name: "unsupported",
        report: results.unsupported,
        code: "unsupported_v2_block"
      },
      { name: "altered", report: results.altered, code: "content_changed" },
      {
        name: "malformed",
        report: results.malformed,
        code: "invalid_block_markup"
      },
      {
        name: "escaped delimiter",
        report: results.escapedDelimiter,
        code: "invalid_block_markup"
      }
    ];
    for (const control of controls) {
      assert(
        control.report.outcome === "invalid" &&
          control.report.contentPreservation.passed === false &&
          control.report.issues.some((entry) => entry.code === control.code),
        `Native ${control.name} control did not fail closed with ${control.code}: ${JSON.stringify(control.report).slice(0, 1_000)}`
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function humanEditTitle(postId: number, title: string): Promise<void> {
  const context = await login();
  try {
    const page = await context.newPage();
    await page.goto(
      `${E2E_BASE_URL}wp-admin/post.php?post=${postId}&action=edit`,
      {
        waitUntil: "domcontentloaded"
      }
    );
    const result = await page.evaluate(
      async ({ id, nextTitle }) => {
        const nonce = (
          globalThis as unknown as { wpApiSettings?: { nonce?: string } }
        ).wpApiSettings?.nonce;
        if (!nonce) return { status: 0, body: "missing nonce" };
        const response = await fetch(`/wp-json/wp/v2/posts/${id}`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-wp-nonce": nonce },
          body: JSON.stringify({ title: nextTitle })
        });
        return { status: response.status, body: await response.text() };
      },
      { id: postId, nextTitle: title }
    );
    assert(
      result.status >= 200 && result.status < 300,
      `Human edit failed with HTTP ${result.status}: ${result.body.slice(0, 300)}`
    );
  } finally {
    await context.browser()?.close();
  }
}

async function nativeSaveAndReopen(
  postId: number
): Promise<{ blockCount: number; allValid: boolean }> {
  const context = await login();
  try {
    const savePage = await context.newPage();
    await savePage.goto(
      `${E2E_BASE_URL}wp-admin/post.php?post=${postId}&action=edit`,
      {
        waitUntil: "domcontentloaded"
      }
    );
    await savePage.waitForFunction(
      (id) => {
        const wp = (
          globalThis as unknown as {
            wp?: {
              data?: { select(store: string): { getCurrentPostId?(): number } };
            };
          }
        ).wp;
        return wp?.data?.select("core/editor").getCurrentPostId?.() === id;
      },
      postId,
      { timeout: 30_000 }
    );
    await savePage.evaluate(async () => {
      const wp = (
        globalThis as unknown as {
          wp: {
            data: {
              dispatch(store: string): { savePost(): Promise<unknown> };
            };
          };
        }
      ).wp;
      await wp.data.dispatch("core/editor").savePost();
    });
    await savePage.waitForFunction(
      () => {
        const wp = (
          globalThis as unknown as {
            wp?: {
              data?: {
                select(store: string): {
                  isSavingPost?(): boolean;
                  isEditedPostDirty?(): boolean;
                };
              };
            };
          }
        ).wp;
        const editor = wp?.data?.select("core/editor");
        return (
          editor?.isSavingPost?.() === false &&
          editor.isEditedPostDirty?.() === false
        );
      },
      undefined,
      { timeout: 30_000 }
    );
    await savePage.close();

    const reopenPage = await context.newPage();
    await reopenPage.goto(
      `${E2E_BASE_URL}wp-admin/post.php?post=${postId}&action=edit`,
      {
        waitUntil: "domcontentloaded"
      }
    );
    await reopenPage.waitForFunction(
      () => {
        const wp = (
          globalThis as unknown as {
            wp?: {
              data?: { select(store: string): { getBlocks?(): unknown[] } };
            };
          }
        ).wp;
        return (
          (wp?.data?.select("core/block-editor").getBlocks?.().length ?? 0) > 0
        );
      },
      undefined,
      { timeout: 30_000 }
    );
    return await reopenPage.evaluate(() => {
      type NativeBlock = { isValid?: boolean; innerBlocks?: NativeBlock[] };
      const wp = (
        globalThis as unknown as {
          wp: {
            data: { select(store: string): { getBlocks(): NativeBlock[] } };
          };
        }
      ).wp;
      const roots = wp.data.select("core/block-editor").getBlocks();
      let blockCount = 0;
      let allValid = true;
      const stack: NativeBlock[] = [...roots];
      while (stack.length > 0) {
        const block = stack.pop();
        if (!block) continue;
        blockCount += 1;
        allValid = allValid && block.isValid === true;
        stack.push(...(block.innerBlocks ?? []));
      }
      return { blockCount, allValid };
    });
  } finally {
    await context.browser()?.close();
  }
}

async function main(): Promise<void> {
  assert(
    E2E_BASE_URL === EXACT_TEST_URL,
    `Refusing v2 E2E against ${E2E_BASE_URL}.`
  );
  const runId = new Date().toISOString().replaceAll(":", "-");
  const artifactDirectory = join(E2E_ARTIFACTS_ROOT, `v2-gutenberg-${runId}`);
  mkdirSync(artifactDirectory, { recursive: true });
  const registration = await registerTestClient();
  const sessionClient = new WordPressEditorSessionClient({
    siteUrl: E2E_BASE_URL,
    siteId: registration.siteId,
    clientId: registration.clientId,
    sharedSecret: registration.secret
  });
  const stagedAssets = new FileGutenbergV2StagedAssetStore(
    join(artifactDirectory, "staged-media")
  );
  const runtime = createSignedGutenbergV2Runtime({
    siteUrl: E2E_BASE_URL,
    siteId: registration.siteId,
    clientId: registration.clientId,
    sharedSecret: registration.secret,
    stagedAssets,
    reviewArtifactDirectory: join(artifactDirectory, "review"),
    ignoreHTTPSErrors: true,
    maxConcurrentJobs: 1,
    jobTimeoutMs: 120_000
  });
  const { worker, transport: wordpress, media } = runtime;
  const staged = await stagedAssets.stage({
    bytes: readFileSync(join(process.cwd(), "tests/e2e/fixtures/test.jpeg")),
    mediaType: "image/jpeg"
  });
  const stagedVideo = await stagedAssets.stage({
    bytes: readFileSync(join(process.cwd(), "tests/e2e/fixtures/test.mp4")),
    mediaType: "video/mp4"
  });
  const database = new Database(join(artifactDirectory, "journal.sqlite"));
  const journal = new SqliteGutenbergV2ExecutionJournal(database);
  const approvals = new SqliteGutenbergV2ApprovalStore(database);
  const service = new GutenbergV2ContentService({
    worker,
    wordpress,
    journal,
    approvals,
    media
  });
  let swallowedCommitReceipt:
    | Awaited<ReturnType<GutenbergV2WordPressTransport["commitCandidate"]>>
    | undefined;
  let loseNextCommitResponse = true;
  const uncertainWordpress: GutenbergV2WordPressTransport = {
    readSource: (input) => wordpress.readSource(input),
    prepareCommit: (input) => wordpress.prepareCommit(input),
    commitCandidate: async (input) => {
      const receipt = await wordpress.commitCandidate(input);
      if (loseNextCommitResponse) {
        loseNextCommitResponse = false;
        swallowedCommitReceipt = receipt;
        throw new Error(
          "simulated lost commit response after WordPress applied the write"
        );
      }
      return receipt;
    },
    reconcileExecution: (input) => wordpress.reconcileExecution(input),
    readBack: (input) => wordpress.readBack(input),
    conditionalRollback: (input) => wordpress.conditionalRollback(input)
  };
  const uncertainService = new GutenbergV2ContentService({
    worker,
    wordpress: uncertainWordpress,
    journal,
    approvals,
    media
  });

  try {
    // Focused runs while developing one scenario; the release gate runs all.
    const only = process.env.SITEPILOT_V2_E2E_ONLY;
    if (only === "new-blocks") {
      console.log(
        JSON.stringify(
          await runNewBlocksWorkflow(
            service,
            worker,
            registration.siteId,
            staged,
            stagedVideo
          ),
          null,
          2
        )
      );
      return;
    }
    if (only === "preservation") {
      console.log(
        JSON.stringify(
          await runPreservationWorkflow(service, worker, registration.siteId),
          null,
          2
        )
      );
      return;
    }
    const title = `AUTOMATED-TEST-V2-${runId}`;
    const creationPlan = createPlan(registration.siteId, title, staged);
    const expectedNodeCount = countPlanNodes(creationPlan);
    const buttonWidthProbe = await runButtonWidthProbe(
      worker,
      registration.siteId
    );
    console.log(
      `core/button width probe: ${buttonWidthProbe.outcome} (${buttonWidthProbe.disposition})`
    );
    const capabilities = await service.discoverCapabilities({
      siteId: registration.siteId,
      postType: "post"
    });
    const capabilitySummary = capabilityEvidence(capabilities);
    writeFileSync(
      join(artifactDirectory, "capability-summary.json"),
      `${JSON.stringify(capabilitySummary, null, 2)}\n`,
      "utf8"
    );
    const createExecution = `execution-${randomUUID()}`;
    const createIdempotency = `idempotency-${randomUUID()}`;
    let candidate: GutenbergV2CompiledCandidate;
    try {
      candidate = await service.compileCandidate({
        executionId: createExecution,
        idempotencyKey: createIdempotency,
        plan: creationPlan
      });
    } catch (error) {
      if (error instanceof GutenbergV2ServiceError) {
        console.error(
          `Native create compile failed: ${boundedServiceDiagnostic(error)}`
        );
      }
      throw error;
    }
    const createApproval = approval(candidate);
    await service.recordApproval({
      executionId: createExecution,
      approval: createApproval
    });
    const firstMediaBinding = await media.resolveForCommit({
      executionId: createExecution,
      idempotencyKey: createIdempotency,
      candidate,
      approval: createApproval
    });
    const retriedMediaBinding = await media.resolveForCommit({
      executionId: createExecution,
      idempotencyKey: createIdempotency,
      candidate,
      approval: createApproval
    });
    assert(
      JSON.stringify(firstMediaBinding) === JSON.stringify(retriedMediaBinding),
      "Retrying media binding did not reuse the same attachment identities."
    );
    const libraryExecution = `execution-${randomUUID()}`;
    const libraryCandidate = await service.compileCandidate({
      executionId: libraryExecution,
      idempotencyKey: `idempotency-${randomUUID()}`,
      plan: libraryReusePlan(
        creationPlan,
        firstMediaBinding.mapping,
        `${title}-LIBRARY-PREVIEW`
      )
    });
    assert(
      libraryCandidate.validation.outcome === "valid" &&
        libraryCandidate.mediaManifest.length === 2,
      "Existing library attachments did not pass trusted native preview compilation."
    );
    const created = await service.executeApprovedCandidate({
      executionId: createExecution
    });
    assert(
      created.state === "succeeded" && created.postId,
      `Create execution ended in ${created.state}.`
    );
    const createJob = await journal.get(createExecution);
    assert(
      createJob?.preparedCommit,
      "Create execution did not retain its prepared commit."
    );
    const readback = await wordpress.readBack({
      schemaVersion: "sitepilot.readback-request/v2",
      siteId: registration.siteId,
      executionId: createExecution,
      postId: created.postId
    });
    assert(
      readback.rawContent === createJob.preparedCommit.finalContent,
      "Persisted raw Gutenberg bytes differ from prepared bytes."
    );
    assert(
      readback.fields.title === title && readback.fields.status === "draft",
      "Created post fields differ from approval."
    );
    const nativeReopen = await nativeSaveAndReopen(created.postId);
    assert(
      nativeReopen.allValid && nativeReopen.blockCount === expectedNodeCount,
      `Normal editor save/reopen returned ${nativeReopen.blockCount}/${expectedNodeCount} native blocks (allValid=${nativeReopen.allValid}).`
    );
    const afterNativeSave = await wordpress.readBack({
      schemaVersion: "sitepilot.readback-request/v2",
      siteId: registration.siteId,
      executionId: createExecution,
      postId: created.postId
    });
    assert(
      afterNativeSave.contentHash === readback.contentHash,
      "Normal editor save changed approved Gutenberg bytes."
    );
    assert(
      afterNativeSave.fieldsHash === readback.fieldsHash,
      "Normal editor save changed approved post fields."
    );
    await assertReadOnlySession(
      sessionClient,
      registration.siteId,
      created.postId
    );
    await assertNativeNegativeControls(sessionClient, registration.siteId);
    const historicalWorkflow = await runHistoricalWorkflow(
      service,
      worker,
      registration.siteId,
      staged
    );
    const preservationWorkflow = await runPreservationWorkflow(
      service,
      worker,
      registration.siteId
    );
    const newBlocksWorkflow = await runNewBlocksWorkflow(
      service,
      worker,
      registration.siteId,
      staged,
      stagedVideo
    );

    const lostExecution = `execution-${randomUUID()}`;
    const lostCandidate = await uncertainService.compileCandidate({
      executionId: lostExecution,
      idempotencyKey: `idempotency-${randomUUID()}`,
      plan: createPlan(registration.siteId, `${title}-LOST-RESPONSE`, staged)
    });
    await uncertainService.recordApproval({
      executionId: lostExecution,
      approval: approval(lostCandidate)
    });
    await uncertainService.prepareCommit({ executionId: lostExecution });
    let lostResponseRejected = false;
    try {
      await uncertainService.commitCandidate({ executionId: lostExecution });
    } catch (error) {
      lostResponseRejected =
        error instanceof GutenbergV2ServiceError &&
        error.code === "conditional_commit_failed" &&
        error.retryable;
    }
    assert(
      lostResponseRejected && swallowedCommitReceipt,
      "Lost commit response was not retained as an uncertain retryable outcome."
    );
    const reconciledReceipt = await uncertainService.commitCandidate({
      executionId: lostExecution
    });
    assert(
      reconciledReceipt.disposition === "reconciled",
      "Lost commit response retry did not reconcile the durable receipt."
    );
    assert(
      reconciledReceipt.postId === swallowedCommitReceipt.postId,
      "Lost commit response retry created a duplicate post."
    );
    const lostResult = await uncertainService.verifyPersistedContent({
      executionId: lostExecution,
      receipt: reconciledReceipt
    });
    assert(
      lostResult.state === "succeeded",
      `Reconciled execution ended in ${lostResult.state}.`
    );

    const source = await worker.readSource({
      executionId: `source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId: created.postId
    });
    assert(
      source.blockIndex.length === expectedNodeCount,
      `Native source index returned ${source.blockIndex.length}/${expectedNodeCount}: ${JSON.stringify(source.blockIndex.slice(0, 30).map(({ path, name }) => ({ path, name })))}`
    );
    const updateExecution = `execution-${randomUUID()}`;
    const updateTitle = `${title}-V2-UPDATE`;
    const updateCandidate = await service.compileCandidate({
      executionId: updateExecution,
      idempotencyKey: `idempotency-${randomUUID()}`,
      plan: replacementPlan(registration.siteId, source, updateTitle)
    });
    await service.recordApproval({
      executionId: updateExecution,
      approval: approval(updateCandidate)
    });
    await service.prepareCommit({ executionId: updateExecution });
    const receipt = await service.commitCandidate({
      executionId: updateExecution
    });
    const humanTitle = `${title}-HUMAN-CONFLICT`;
    await humanEditTitle(created.postId, humanTitle);
    const conflict = await service.verifyPersistedContent({
      executionId: updateExecution,
      receipt
    });
    assert(
      conflict.state === "rollback_conflict",
      `Human edit should produce rollback_conflict, got ${conflict.state}.`
    );
    const afterConflict = await wordpress.readBack({
      schemaVersion: "sitepilot.readback-request/v2",
      siteId: registration.siteId,
      executionId: updateExecution,
      postId: created.postId
    });
    assert(
      afterConflict.fields.title === humanTitle,
      "Conditional rollback overwrote a later human title edit."
    );

    const staleSource = await worker.readSource({
      executionId: `source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId: created.postId
    });
    const staleExecution = `execution-${randomUUID()}`;
    const staleCandidate = await service.compileCandidate({
      executionId: staleExecution,
      idempotencyKey: `idempotency-${randomUUID()}`,
      plan: replacementPlan(
        registration.siteId,
        staleSource,
        `${title}-STALE-CANDIDATE`
      )
    });
    await service.recordApproval({
      executionId: staleExecution,
      approval: approval(staleCandidate)
    });
    await service.prepareCommit({ executionId: staleExecution });
    const afterPrepareTitle = `${title}-EDITED-AFTER-PREPARE`;
    await humanEditTitle(created.postId, afterPrepareTitle);
    let staleCommitRejected = false;
    try {
      await service.commitCandidate({ executionId: staleExecution });
    } catch (error) {
      staleCommitRejected =
        error instanceof GutenbergV2ServiceError &&
        error.code === "conditional_commit_failed";
    }
    assert(
      staleCommitRejected,
      "A human edit between prepare and commit did not reject the stale source."
    );
    const afterStaleRejection = await wordpress.readBack({
      schemaVersion: "sitepilot.readback-request/v2",
      siteId: registration.siteId,
      executionId: staleExecution,
      postId: created.postId
    });
    assert(
      afterStaleRejection.fields.title === afterPrepareTitle,
      "Stale conditional commit overwrote the human edit."
    );

    const scopedSource = await worker.readSource({
      executionId: `source-${randomUUID()}`,
      siteId: registration.siteId,
      postType: "post",
      postId: created.postId
    });
    const scopedExecution = `execution-${randomUUID()}`;
    const scopedCandidate = await service.compileCandidate({
      executionId: scopedExecution,
      idempotencyKey: `idempotency-${randomUUID()}`,
      plan: scopedInsertPlan(registration.siteId, scopedSource)
    });
    await service.recordApproval({
      executionId: scopedExecution,
      approval: approval(scopedCandidate)
    });
    await service.prepareCommit({ executionId: scopedExecution });
    const scopedReceipt = await service.commitCandidate({
      executionId: scopedExecution
    });
    const restored = await wordpress.conditionalRollback({
      schemaVersion: "sitepilot.recover-request/v2",
      siteId: registration.siteId,
      executionId: scopedExecution,
      postId: scopedReceipt.postId,
      beforeStateRef: scopedReceipt.beforeStateRef,
      expectedWrittenContentHash: scopedReceipt.persistedContentHash,
      expectedWrittenRevision: scopedReceipt.persistedRevision,
      expectedWrittenFieldsHash: scopedReceipt.persistedFieldsHash
    });
    assert(
      restored.outcome === "restored",
      `Conditional rollback returned ${restored.outcome}.`
    );
    const afterRestore = await wordpress.readBack({
      schemaVersion: "sitepilot.readback-request/v2",
      siteId: registration.siteId,
      executionId: scopedExecution,
      postId: created.postId
    });
    assert(
      afterRestore.contentHash === scopedSource.contentHash,
      "Conditional rollback did not restore source content bytes."
    );
    assert(
      afterRestore.fieldsHash === scopedSource.fieldsHash,
      "Conditional rollback did not restore source fields."
    );

    const summary = {
      schemaVersion: "sitepilot.v2-e2e-result/v1",
      siteId: registration.siteId,
      createExecution,
      libraryExecution,
      updateExecution,
      lostExecution,
      staleExecution,
      scopedExecution,
      postId: created.postId,
      createdState: created.state,
      conflictState: conflict.state,
      lostResponseState: lostResult.state,
      lostResponseDisposition: reconciledReceipt.disposition,
      staleCommitRejected,
      buttonWidthProbe,
      capabilitySummary,
      historicalWorkflow,
      preservationWorkflow,
      newBlocksWorkflow,
      nativeSaveReopen: nativeReopen,
      scopedRollbackOutcome: restored.outcome,
      contentHash: readback.contentHash,
      fieldsHash: readback.fieldsHash,
      sourceBlockIndex: source.blockIndex,
      mediaAttachmentIds: firstMediaBinding.mapping.map(
        ({ attachmentId }) => attachmentId
      ),
      createdResources: {
        primaryDraft: {
          postId: created.postId,
          mediaIds: firstMediaBinding.mapping.map(
            ({ attachmentId }) => attachmentId
          ),
          cleanup: {
            attempted: false,
            outcome: "retained_for_inspection",
            reason:
              "The v2 transport has no exact execution-owned delete operation; the created draft and media remain recorded for manual cleanup."
          }
        },
        reconciledDraft: {
          postId: reconciledReceipt.postId,
          cleanup: {
            attempted: false,
            outcome: "retained_for_inspection",
            reason:
              "The v2 transport has no exact execution-owned delete operation; the created draft remains recorded for manual cleanup."
          }
        },
        historicalDraft: {
          postId: historicalWorkflow.postId,
          mediaIds: historicalWorkflow.mediaIds,
          cleanup: {
            attempted: false,
            outcome: "retained_for_inspection",
            reason:
              "The v2 transport has no exact execution-owned delete operation; the historical workflow draft remains recorded for manual cleanup."
          }
        }
      },
      reviewArtifact: candidate.reviewArtifact
    };
    writeFileSync(
      join(artifactDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8"
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    database.close();
    await worker.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exitCode = 1;
});
