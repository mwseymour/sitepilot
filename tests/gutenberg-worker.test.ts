import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, Route } from "playwright";

import {
  gutenbergV2CompiledCandidateSchema,
  gutenbergV2PreparedCommitSchema,
  type GutenbergV2BlockPlan,
  type GutenbergV2EditorCapabilitySnapshot,
  type GutenbergV2ValidationReport
} from "@sitepilot/contracts";
import {
  FileGutenbergV2ReviewArtifactStore,
  PlaywrightGutenbergV2Worker,
  SignedWordPressV2Transport,
  TrustedGutenbergV2PreviewMediaResolver,
  WordPressEditorSessionClient,
  type GutenbergV2EditorSessionProvider
} from "@sitepilot/gutenberg-worker";
import {
  hashGutenbergV2Content,
  hashGutenbergV2Bytes,
  hashGutenbergV2PreviewMediaManifest,
  hashGutenbergV2Value
} from "@sitepilot/services";

const temporaryDirectories: string[] = [];
const serializedContent =
  "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->";
const mockScreenshot = Buffer.alloc(24);
mockScreenshot.set(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 0);
mockScreenshot.write("IHDR", 12, "ascii");
mockScreenshot.writeUInt32BE(800, 16);
mockScreenshot.writeUInt32BE(2_400, 20);

function blockPlan(): GutenbergV2BlockPlan {
  return {
    schemaVersion: "sitepilot.block-plan/v2",
    planId: "plan-1",
    siteId: "site-1",
    operation: "create_draft",
    target: { postType: "post" },
    postFields: { title: "Expected title", status: "draft" },
    blocks: [
      {
        ref: "paragraph-1",
        name: "core/paragraph",
        attributes: { content: "Hello" },
        children: []
      }
    ],
    media: []
  };
}

function capabilitySnapshot(): GutenbergV2EditorCapabilitySnapshot {
  return {
    schemaVersion: "sitepilot.editor-capabilities/v2",
    siteId: "site-1",
    siteUrl: "https://example.test",
    bridgeVersion: "2.0.0",
    wordpressVersion: "7.1.1",
    fingerprint: "1".repeat(64),
    capturedAt: "2026-09-22T12:00:00.000Z",
    context: {
      postType: "post",
      userId: 7,
      userRoles: ["editor"],
      theme: "twentytwentyfive",
      pluginFingerprint: "2".repeat(64),
      editorSettingsFingerprint: "3".repeat(64)
    },
    blocks: [
      {
        name: "core/paragraph",
        registered: true,
        allowed: true,
        v2Support: "author",
        dynamic: false,
        attributeSchemaHash: "4".repeat(64),
        allowedParents: [],
        allowedAncestors: [],
        allowedChildren: [],
        supportsHtml: false,
        lock: "none"
      }
    ]
  };
}

function validReport(
  intent: GutenbergV2BlockPlan = blockPlan()
): GutenbergV2ValidationReport {
  const intentHash = hashGutenbergV2Value(intent);
  return {
    outcome: "valid",
    expectedBlockCount: 1,
    observedBlockCount: 1,
    issues: [],
    contentPreservation: {
      passed: true,
      checked: [
        "text",
        "inline_markup",
        "links",
        "media",
        "captions",
        "ordering",
        "layout"
      ],
      intentHash,
      observedIntentHash: intentHash
    }
  };
}

function mockSessionProvider(): GutenbergV2EditorSessionProvider {
  return {
    createSession: vi.fn(async (request) => ({
      schemaVersion: "sitepilot.editor-session/v2",
      bootstrapToken: "b".repeat(32),
      bootstrapUrl: "https://example.test/bootstrap",
      expiresAt: "2099-09-22T12:00:00.000Z",
      context: {
        executionId: request.executionId,
        siteId: request.siteId,
        postType: request.context.postType,
        ...(request.context.postId === undefined
          ? {}
          : { postId: request.context.postId })
      }
    })),
    bootstrapSession: vi.fn(async () => ({
      schemaVersion: "sitepilot.editor-bootstrap/v2",
      editorUrl: "https://example.test/wp-admin/post.php?sitepilot-v2=1",
      expiresAt: "2099-09-22T12:00:00.000Z"
    }))
  };
}

function mockBrowser(options?: {
  compileReport?: (plan: GutenbergV2BlockPlan) => GutenbergV2ValidationReport;
  mediaResponseBytes?: Buffer;
}) {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  let lastBridgePayload: unknown;
  const bridgePayloads: unknown[] = [];
  const previewRootEvaluate = vi.fn(
    async (_callback: unknown, argument?: unknown) => {
      if (
        typeof argument === "object" &&
        argument !== null &&
        "maxHeight" in argument
      ) {
        const maxWidth =
          "maxWidth" in argument && typeof argument.maxWidth === "number"
            ? argument.maxWidth
            : 800;
        return {
          originalStyle: null,
          accessible: true,
          stable: true,
          covered: true,
          width: Math.min(800, maxWidth),
          renderedHeight: 2_400,
          contentHeight: 2_400
        };
      }
      return undefined;
    }
  );
  const page = {
    request: {
      get: vi.fn(async () => ({
        status: () => 200,
        headers: () => ({
          "content-length": String(options?.mediaResponseBytes?.byteLength ?? 0)
        }),
        body: async () => options?.mediaResponseBytes ?? Buffer.alloc(0)
      }))
    },
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(async () => ({ ok: () => true, status: () => 200 })),
    url: vi.fn(() => "https://example.test/wp-admin/post.php?sitepilot-v2=1"),
    waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async (_callback: unknown, payload?: unknown) => {
      if (payload === undefined) return capabilitySnapshot();
      lastBridgePayload = payload;
      bridgePayloads.push(payload);
      if (Array.isArray(payload)) return [];
      if (
        typeof payload === "object" &&
        payload !== null &&
        "plan" in payload
      ) {
        const plan = (payload as { plan: GutenbergV2BlockPlan }).plan;
        return {
          schemaVersion: "sitepilot.editor-compile-result/v2",
          planId: plan.planId,
          operation: plan.operation,
          serializedContent,
          contentHash: hashGutenbergV2Content(serializedContent),
          intentHash: hashGutenbergV2Value(plan),
          capabilityFingerprint: capabilitySnapshot().fingerprint,
          validation: options?.compileReport?.(plan) ?? validReport(plan),
          compiledAt: "2026-09-22T12:00:00.000Z"
        };
      }
      if (
        typeof payload === "object" &&
        payload !== null &&
        "viewport" in payload
      ) {
        const previewMediaMapping =
          (payload as { previewMediaMapping?: [] }).previewMediaMapping ?? [];
        return {
          schemaVersion: "sitepilot.editor-preview-result/v2",
          renderedContentHash: hashGutenbergV2Content(serializedContent),
          previewMediaManifestHash:
            hashGutenbergV2PreviewMediaManifest(previewMediaMapping),
          rootSelector: "#sitepilot-v2-preview"
        };
      }
      return validReport();
    }),
    setViewportSize: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => undefined),
      evaluate: previewRootEvaluate,
      screenshot: vi.fn(async () => mockScreenshot)
    }))
  };
  const context = {
    request: {},
    route: vi.fn(
      async (_pattern: string, handler: (route: Route) => Promise<void>) => {
        routeHandler = handler;
      }
    ),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined)
  };
  const browser = {
    newContext: vi.fn(async () => context),
    isConnected: vi.fn(() => true),
    close: vi.fn(async () => undefined)
  } as unknown as Browser;
  return {
    browser,
    getRouteHandler: () => routeHandler,
    getLastBridgePayload: () => lastBridgePayload,
    getBridgePayloads: () => bridgePayloads,
    getPreviewRootEvaluate: () => previewRootEvaluate
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("PlaywrightGutenbergV2Worker", () => {
  it("compiles through the destination bridge and writes real private review artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-worker-"));
    temporaryDirectories.push(directory);
    const artifacts = new FileGutenbergV2ReviewArtifactStore(directory);
    const mocked = mockBrowser();
    const worker = new PlaywrightGutenbergV2Worker({
      siteUrl: "https://example.test",
      sessionProvider: mockSessionProvider(),
      reviewArtifacts: artifacts,
      browserFactory: async () => mocked.browser
    });
    const result = await worker.compile({
      candidateId: "candidate-1",
      plan: blockPlan(),
      capabilities: capabilitySnapshot()
    });
    expect(result.contentHash).toBe(hashGutenbergV2Content(serializedContent));
    expect(
      (await artifacts.read(result.reviewArtifact.structureDiffRef)).toString(
        "utf8"
      )
    ).toContain('"after":{"plan"');
    expect(result.reviewArtifact.previewRefs).toHaveLength(2);
    expect(mocked.getPreviewRootEvaluate()).toHaveBeenCalledTimes(4);
    expect(mocked.getPreviewRootEvaluate()).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxHeight: 24_000 })
    );
    expect(await artifacts.read(result.reviewArtifact.previewRefs[0]!)).toEqual(
      mockScreenshot
    );
    const rerendered = await artifacts.write({
      candidateId: "candidate-1",
      plan: blockPlan(),
      serializedContent,
      serializedContentHash: hashGutenbergV2Content(serializedContent),
      capabilityFingerprint: capabilitySnapshot().fingerprint,
      screenshots: [
        { viewport: "desktop", data: Buffer.from([1, 2, 3]) },
        { viewport: "mobile", data: Buffer.from([4, 5, 6]) }
      ]
    });
    expect(rerendered.structureDiffRef).toBe(
      result.reviewArtifact.structureDiffRef
    );
    expect(rerendered.previewRefs).not.toEqual(
      result.reviewArtifact.previewRefs
    );

    const abort = vi.fn(async () => undefined);
    const route = {
      request: () => ({
        url: () => "https://evil.example/steal",
        method: () => "GET"
      }),
      abort,
      continue: vi.fn()
    } as unknown as Route;
    await mocked.getRouteHandler()?.(route);
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    await worker.close();
  });

  it("verifies persisted content against prepared bytes and adds post-field evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-worker-"));
    temporaryDirectories.push(directory);
    const artifacts = new FileGutenbergV2ReviewArtifactStore(directory);
    const mocked = mockBrowser();
    const worker = new PlaywrightGutenbergV2Worker({
      siteUrl: "https://example.test",
      sessionProvider: mockSessionProvider(),
      reviewArtifacts: artifacts,
      browserFactory: async () => mocked.browser
    });
    const compiled = await worker.compile({
      candidateId: "candidate-1",
      plan: blockPlan(),
      capabilities: capabilitySnapshot()
    });
    const candidate = gutenbergV2CompiledCandidateSchema.parse({
      schemaVersion: "sitepilot.compiled-candidate/v2",
      candidateId: "candidate-1",
      planId: blockPlan().planId,
      siteId: blockPlan().siteId,
      operation: blockPlan().operation,
      intent: blockPlan(),
      requestedPostFields: { title: "Expected title", status: "draft" },
      serializedContent,
      contentHash: compiled.contentHash,
      intentHash: compiled.intentHash,
      requestedFieldsHash: hashGutenbergV2Value({
        title: "Expected title",
        status: "draft"
      }),
      sourceState: { affectedFieldsHash: hashGutenbergV2Value({}) },
      capabilityFingerprint: compiled.capabilityFingerprint,
      mediaManifest: [],
      mediaManifestHash: hashGutenbergV2Value([]),
      validation: compiled.validation,
      reviewArtifact: compiled.reviewArtifact,
      compiledAt: "2026-09-22T12:00:00.000Z"
    });
    const prepared = gutenbergV2PreparedCommitSchema.parse({
      schemaVersion: "sitepilot.prepared-commit/v2",
      preparedCommitId: "prepared-1",
      executionId: "execution-1",
      idempotencyKey: "key-1",
      approvalId: "approval-1",
      candidateId: candidate.candidateId,
      siteId: candidate.siteId,
      operation: candidate.operation,
      requestedFieldsHash: candidate.requestedFieldsHash,
      affectedFieldsHash: candidate.sourceState.affectedFieldsHash,
      capabilityFingerprint: candidate.capabilityFingerprint,
      intentHash: candidate.intentHash,
      approvedContentHash: candidate.contentHash,
      mediaManifestHash: candidate.mediaManifestHash,
      mediaMapping: [],
      finalContent: serializedContent,
      finalContentHash: hashGutenbergV2Content(serializedContent),
      serverPreparedContentHash: hashGutenbergV2Content(serializedContent),
      serverPreparedFieldsHash: hashGutenbergV2Value({
        title: "Expected title",
        excerpt: "",
        status: "draft"
      }),
      preparedAt: "2026-09-22T12:00:00.000Z",
      expiresAt: "2026-09-22T13:00:00.000Z"
    });
    const report = await worker.verifyPersistedContent({
      candidate,
      preparedCommit: prepared,
      capabilities: capabilitySnapshot(),
      readback: {
        schemaVersion: "sitepilot.readback/v2",
        siteId: "site-1",
        executionId: "execution-1",
        postId: 42,
        postType: "post",
        revision: "revision-2",
        rawContent: serializedContent,
        contentHash: hashGutenbergV2Content(serializedContent),
        fields: { title: "Mutated title", excerpt: "", status: "draft" },
        fieldsHash: hashGutenbergV2Value({
          title: "Mutated title",
          excerpt: "",
          status: "draft"
        })
      }
    });
    expect(report.outcome).toBe("invalid");
    expect(report.contentPreservation.checked).toContain("post_fields");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "content_changed" })
      ])
    );
    expect(mocked.getLastBridgePayload()).toMatchObject({
      serializedContent,
      expectedSerializedContent: prepared.finalContent
    });
    await worker.close();
  });

  it("rejects final media whose URL bytes no longer match the approved checksum", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-worker-"));
    temporaryDirectories.push(directory);
    const approvedBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const approvedChecksum = hashGutenbergV2Bytes(approvedBytes);
    const mocked = mockBrowser({
      mediaResponseBytes: Buffer.from([137, 80, 78, 71, 0, 0, 0, 0])
    });
    const worker = new PlaywrightGutenbergV2Worker({
      siteUrl: "https://example.test",
      sessionProvider: mockSessionProvider(),
      reviewArtifacts: new FileGutenbergV2ReviewArtifactStore(directory),
      browserFactory: async () => mocked.browser
    });
    const intent: GutenbergV2BlockPlan = {
      ...blockPlan(),
      media: [
        {
          ref: "hero-image",
          source: {
            kind: "staged_asset",
            stagedAssetId: "approved-hero",
            checksum: approvedChecksum,
            mediaType: "image/png",
            byteLength: approvedBytes.byteLength
          },
          alt: "Approved hero"
        }
      ]
    };
    const mediaManifest = [
      {
        ref: "hero-image",
        approvedChecksum,
        alt: "Approved hero"
      }
    ];
    const candidate = gutenbergV2CompiledCandidateSchema.parse({
      schemaVersion: "sitepilot.compiled-candidate/v2",
      candidateId: "candidate-media-check",
      planId: intent.planId,
      siteId: intent.siteId,
      operation: intent.operation,
      intent,
      requestedPostFields: intent.postFields,
      serializedContent,
      contentHash: hashGutenbergV2Content(serializedContent),
      intentHash: hashGutenbergV2Value(intent),
      requestedFieldsHash: hashGutenbergV2Value(intent.postFields),
      sourceState: { affectedFieldsHash: hashGutenbergV2Value({}) },
      capabilityFingerprint: capabilitySnapshot().fingerprint,
      mediaManifest,
      mediaManifestHash: hashGutenbergV2Value(mediaManifest),
      validation: validReport(intent),
      reviewArtifact: {
        structureDiffRef: "structure-media-check",
        previewRefs: ["preview-media-check"]
      },
      compiledAt: "2026-09-22T12:00:00.000Z"
    });
    const mapping = [
      {
        ref: "hero-image",
        approvedChecksum,
        finalChecksum: approvedChecksum,
        attachmentId: 42,
        url: "https://example.test/wp-content/uploads/hero.png"
      }
    ];
    const preparedCommit = gutenbergV2PreparedCommitSchema.parse({
      schemaVersion: "sitepilot.prepared-commit/v2",
      preparedCommitId: "prepared-media-check",
      executionId: "execution-media-check",
      idempotencyKey: "key-media-check",
      approvalId: "approval-media-check",
      candidateId: candidate.candidateId,
      siteId: candidate.siteId,
      operation: candidate.operation,
      requestedFieldsHash: candidate.requestedFieldsHash,
      affectedFieldsHash: candidate.sourceState.affectedFieldsHash,
      capabilityFingerprint: candidate.capabilityFingerprint,
      intentHash: candidate.intentHash,
      approvedContentHash: candidate.contentHash,
      mediaManifestHash: candidate.mediaManifestHash,
      mediaMapping: mapping,
      finalContent: serializedContent,
      finalContentHash: hashGutenbergV2Content(serializedContent),
      serverPreparedContentHash: hashGutenbergV2Content(serializedContent),
      serverPreparedFieldsHash: hashGutenbergV2Value({
        title: "Expected title",
        excerpt: "",
        status: "draft"
      }),
      preparedAt: "2026-09-22T12:00:00.000Z",
      expiresAt: "2026-09-22T13:00:00.000Z"
    });

    await expect(
      worker.verifyPersistedContent({
        candidate,
        preparedCommit,
        capabilities: capabilitySnapshot(),
        readback: {
          schemaVersion: "sitepilot.readback/v2",
          siteId: "site-1",
          executionId: "execution-media-check",
          postId: 42,
          postType: "post",
          revision: "revision-2",
          rawContent: serializedContent,
          contentHash: hashGutenbergV2Content(serializedContent),
          fields: { title: "Expected title", excerpt: "", status: "draft" },
          fieldsHash: hashGutenbergV2Value({
            title: "Expected title",
            excerpt: "",
            status: "draft"
          })
        }
      })
    ).rejects.toMatchObject({ code: "media_changed", retryable: false });
    await worker.close();
  });

  it("renders approved staged media in review without an attachment id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-worker-"));
    temporaryDirectories.push(directory);
    const mocked = mockBrowser();
    const mediaPlan: GutenbergV2BlockPlan = {
      ...blockPlan(),
      media: [
        {
          ref: "hero-image",
          source: {
            kind: "staged_asset",
            stagedAssetId: "staged-hero",
            checksum: "7".repeat(64),
            mediaType: "image/png",
            byteLength: 8
          },
          alt: "Hero"
        }
      ]
    };
    const worker = new PlaywrightGutenbergV2Worker({
      siteUrl: "https://example.test",
      sessionProvider: mockSessionProvider(),
      reviewArtifacts: new FileGutenbergV2ReviewArtifactStore(directory),
      previewMedia: {
        resolvePreviewMedia: vi.fn(async () => [
          {
            ref: "hero-image",
            approvedChecksum: "7".repeat(64),
            dataUrl: "data:image/png;base64,iVBORw0KGgo="
          }
        ])
      },
      browserFactory: async () => mocked.browser
    });

    await worker.compile({
      candidateId: "candidate-with-media",
      plan: mediaPlan,
      capabilities: capabilitySnapshot()
    });
    const previews = mocked
      .getBridgePayloads()
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          "viewport" in payload
      );
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({
      previewMediaMapping: [
        {
          ref: "hero-image",
          approvedChecksum: "7".repeat(64),
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        }
      ]
    });
    expect(previews[0]?.previewMediaMapping).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attachmentId: expect.anything() })
      ])
    );
    await worker.close();
  });

  it("preserves native validation issues when compilation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-worker-"));
    temporaryDirectories.push(directory);
    const mocked = mockBrowser({
      compileReport: (intent) => {
        const intentHash = hashGutenbergV2Value(intent);
        return {
          outcome: "invalid",
          expectedBlockCount: 1,
          observedBlockCount: 1,
          issues: [
            {
              code: "content_changed",
              severity: "error",
              phase: "compile",
              message: "The destination normalized button width."
            }
          ],
          contentPreservation: {
            passed: false,
            checked: [
              "text",
              "inline_markup",
              "links",
              "media",
              "captions",
              "ordering",
              "layout"
            ],
            intentHash,
            observedIntentHash: "9".repeat(64)
          }
        };
      }
    });
    const worker = new PlaywrightGutenbergV2Worker({
      siteUrl: "https://example.test",
      sessionProvider: mockSessionProvider(),
      reviewArtifacts: new FileGutenbergV2ReviewArtifactStore(directory),
      browserFactory: async () => mocked.browser
    });

    await expect(
      worker.compile({
        candidateId: "candidate-invalid",
        plan: blockPlan(),
        capabilities: capabilitySnapshot()
      })
    ).rejects.toMatchObject({
      code: "content_changed",
      message: "The destination normalized button width.",
      issues: [expect.objectContaining({ code: "content_changed" })]
    });
    await worker.close();
  });

  it("previews an existing library attachment without mutating or substituting it", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const checksum = hashGutenbergV2Bytes(png);
    const mediaBindings = {
      resolveMediaBindings: vi.fn(async (_request) => ({
        schemaVersion: "sitepilot.media-bindings-response/v2" as const,
        mapping: [
          {
            ref: "library-hero",
            approvedChecksum: checksum,
            finalChecksum: checksum,
            attachmentId: 42,
            url: "https://example.test/wp-content/uploads/hero.png"
          }
        ],
        createdMediaIds: []
      }))
    };
    const resolver = new TrustedGutenbergV2PreviewMediaResolver({
      siteUrl: "https://example.test",
      stagedAssets: { stage: vi.fn(), read: vi.fn() },
      mediaBindings,
      fetchImplementation: vi.fn(
        async () =>
          new Response(png, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(png.byteLength)
            }
          })
      )
    });
    const libraryPlan: GutenbergV2BlockPlan = {
      ...blockPlan(),
      media: [
        {
          ref: "library-hero",
          source: {
            kind: "library_attachment",
            attachmentId: 42,
            checksum
          },
          alt: "Block-owned alt",
          caption: "Block-owned caption"
        }
      ]
    };

    expect(await resolver.resolvePreviewMedia(libraryPlan)).toEqual([
      {
        ref: "library-hero",
        approvedChecksum: checksum,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`
      }
    ]);
    expect(mediaBindings.resolveMediaBindings).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            kind: "library_attachment",
            attachmentId: 42
          })
        ]
      })
    );
    expect(
      mediaBindings.resolveMediaBindings.mock.calls[0]?.[0].items[0]
    ).not.toHaveProperty("alt");
  });

  it("rejects signed editor-session redirects without forwarding credentials", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/collect" }
        })
    );
    const client = new WordPressEditorSessionClient({
      siteUrl: "https://example.test",
      siteId: "site-1",
      clientId: "worker-1",
      sharedSecret: Buffer.alloc(32, 7),
      fetchImplementation
    });
    await expect(
      client.createSession({
        schemaVersion: "sitepilot.editor-session-request/v2",
        executionId: "execution-1",
        siteId: "site-1",
        context: { postType: "post" }
      })
    ).rejects.toMatchObject({ code: "permission_denied", retryable: false });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual"
    });
  });

  it("preserves a bounded WordPress editor-session error message", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "sitepilot_v2_editor_context_failed",
            message: "A private editor context could not be created.",
            data: { status: 503, code: "editor_context_failed" }
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        )
    );
    const client = new WordPressEditorSessionClient({
      siteUrl: "https://example.test",
      siteId: "site-1",
      clientId: "worker-1",
      sharedSecret: Buffer.alloc(32, 7),
      fetchImplementation
    });

    await expect(
      client.createSession({
        schemaVersion: "sitepilot.editor-session-request/v2",
        executionId: "execution-1",
        siteId: "site-1",
        context: { postType: "post" }
      })
    ).rejects.toMatchObject({
      code: "editor_unavailable",
      retryable: true,
      message: "A private editor context could not be created."
    });
  });

  it("preserves typed WordPress v2 failures from the transport", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "sitepilot_v2_approval_expired",
            message: "The approval expired.",
            data: { status: 409, code: "approval_expired" }
          }),
          { status: 409, headers: { "content-type": "application/json" } }
        )
    );
    const transport = new SignedWordPressV2Transport({
      siteUrl: "https://example.test",
      siteId: "site-1",
      clientId: "worker-1",
      sharedSecret: Buffer.alloc(32, 7),
      sourceReader: { readSource: vi.fn() },
      fetchImplementation
    });

    await expect(
      transport.reconcileExecution({
        schemaVersion: "sitepilot.reconcile-request/v2",
        executionId: "execution-1",
        idempotencyKey: "key-1",
        siteId: "site-1"
      })
    ).rejects.toMatchObject({
      code: "approval_expired",
      retryable: false,
      message: "The approval expired."
    });
  });
});
