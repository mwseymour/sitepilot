import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GutenbergV2Approval,
  GutenbergV2BlockPlan,
  GutenbergV2CommitReceipt,
  GutenbergV2EditorCapabilitySnapshot,
  GutenbergV2PreparedCommit,
  GutenbergV2Readback,
  GutenbergV2SourceSnapshot,
  GutenbergV2ValidationReport
} from "@sitepilot/contracts";
import {
  GutenbergV2ContentService,
  DurableGutenbergV2MediaService,
  FileGutenbergV2StagedAssetStore,
  GutenbergV2ServiceError,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal,
  buildLlmGutenbergV2Plan,
  createGutenbergV2ApprovalBinding,
  hashGutenbergV2Content,
  hashGutenbergV2Value,
  type GutenbergV2WordPressTransport,
  type GutenbergV2Worker
} from "@sitepilot/services";

const connections: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const content = "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->";
const expectedFields = { title: "Draft title", excerpt: "", status: "draft" };

function plan(): GutenbergV2BlockPlan {
  return {
    schemaVersion: "sitepilot.block-plan/v2",
    planId: "plan-1",
    siteId: "site-1",
    operation: "create_draft",
    target: { postType: "post" },
    postFields: { title: expectedFields.title, status: "draft" },
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

function validReport(intentHash: string): GutenbergV2ValidationReport {
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
        "layout",
        "post_fields"
      ],
      intentHash,
      observedIntentHash: intentHash
    }
  };
}

function capabilities(): GutenbergV2EditorCapabilitySnapshot {
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

function harness() {
  const connection = new Database(":memory:");
  connections.push(connection);
  const clockState = { value: new Date("2026-09-22T12:00:00.000Z") };
  let committed = false;
  let commitCalls = 0;
  let readbackCalls = 0;
  let throwAfterCommit = false;
  let failFirstReadback = false;
  let failFirstMediaResponse = false;
  let mediaCalls = 0;
  let mediaSideEffects = 0;
  const mediaInputs: unknown[] = [];
  let persistedFieldsHash = hashGutenbergV2Value(expectedFields);
  let prepared: GutenbergV2PreparedCommit | undefined;
  const receipt = (): GutenbergV2CommitReceipt => ({
    schemaVersion: "sitepilot.commit-receipt/v2",
    executionId: "execution-1",
    idempotencyKey: "key-1",
    preparedCommitId: "prepared-1",
    disposition: committed && commitCalls > 0 ? "reconciled" : "applied",
    postId: 42,
    persistedRevision: "revision-2",
    persistedContentHash: hashGutenbergV2Content(content),
    persistedFieldsHash,
    beforeStateRef: "before-1",
    committedAt: clockState.value.toISOString()
  });

  const worker: GutenbergV2Worker = {
    discoverCapabilities: vi.fn(async () => capabilities()),
    compile: vi.fn(async ({ plan: inputPlan }) => {
      const intentHash = hashGutenbergV2Value(inputPlan);
      return {
        intent: inputPlan,
        serializedContent: content,
        contentHash: hashGutenbergV2Content(content),
        intentHash,
        capabilityFingerprint: capabilities().fingerprint,
        validation: validReport(intentHash),
        reviewArtifact: {
          structureDiffRef: "diff-1",
          previewRefs: ["preview-1"]
        }
      };
    }),
    validatePreparedContent: vi.fn(async ({ candidate }) =>
      validReport(candidate.intentHash)
    ),
    verifyPersistedContent: vi.fn(async ({ candidate }) =>
      validReport(candidate.intentHash)
    )
  };

  const wordpress: GutenbergV2WordPressTransport = {
    readSource: vi.fn(async () => {
      throw new Error("create_draft must not read an existing source");
    }),
    prepareCommit: vi.fn(async (request) => {
      prepared = {
        schemaVersion: "sitepilot.prepared-commit/v2",
        preparedCommitId: "prepared-1",
        executionId: request.executionId,
        idempotencyKey: request.idempotencyKey,
        approvalId: request.approval.approvalId,
        candidateId: request.candidate.candidateId,
        siteId: request.candidate.siteId,
        operation: request.candidate.operation,
        requestedFieldsHash: request.candidate.requestedFieldsHash,
        affectedFieldsHash: request.candidate.sourceState.affectedFieldsHash,
        capabilityFingerprint: request.candidate.capabilityFingerprint,
        intentHash: request.candidate.intentHash,
        approvedContentHash: request.candidate.contentHash,
        mediaManifestHash: request.candidate.mediaManifestHash,
        mediaMapping: request.mediaMapping,
        finalContent: request.finalSerializedContent,
        finalContentHash: request.finalContentHash,
        serverPreparedContentHash: hashGutenbergV2Content(
          request.finalSerializedContent
        ),
        serverPreparedFieldsHash: hashGutenbergV2Value(expectedFields),
        preparedAt: clockState.value.toISOString(),
        expiresAt: new Date(
          clockState.value.getTime() + 2 * 60 * 60 * 1_000
        ).toISOString()
      };
      return {
        schemaVersion: "sitepilot.prepare-commit-response/v2",
        preparedCommit: prepared,
        beforeStateRef: "before-1"
      };
    }),
    reconcileExecution: vi.fn(async () => (committed ? receipt() : null)),
    commitCandidate: vi.fn(async () => {
      commitCalls += 1;
      committed = true;
      if (throwAfterCommit)
        throw new Error("connection lost after response write");
      return receipt();
    }),
    readBack: vi.fn(async (): Promise<GutenbergV2Readback> => {
      readbackCalls += 1;
      if (failFirstReadback && readbackCalls === 1)
        throw new Error("editor session unavailable");
      return {
        schemaVersion: "sitepilot.readback/v2",
        siteId: "site-1",
        executionId: "execution-1",
        postId: 42,
        postType: "post",
        revision: "revision-2",
        rawContent: content,
        contentHash: hashGutenbergV2Content(content),
        fields: expectedFields,
        fieldsHash: persistedFieldsHash
      };
    }),
    conditionalRollback: vi.fn(async () => ({
      schemaVersion: "sitepilot.recover-response/v2",
      outcome: "restored" as const,
      evidenceRef: "rollback-1"
    }))
  };

  const journal = new SqliteGutenbergV2ExecutionJournal(connection);
  const approvals = new SqliteGutenbergV2ApprovalStore(connection);
  const service = new GutenbergV2ContentService({
    worker,
    wordpress,
    journal,
    approvals,
    media: {
      resolveForCommit: vi.fn(async (input) => {
        mediaCalls += 1;
        mediaInputs.push(input);
        if (mediaSideEffects === 0) mediaSideEffects += 1;
        if (failFirstMediaResponse && mediaCalls === 1) {
          throw Object.assign(
            new Error("connection lost after durable media binding"),
            { code: "editor_unavailable", retryable: true }
          );
        }
        return { mapping: [], createdMediaIds: [] };
      })
    },
    clock: { now: () => clockState.value },
    ids: { next: () => "candidate-1" }
  });

  return {
    service,
    journal,
    wordpress,
    worker,
    clockState,
    setThrowAfterCommit: () => {
      throwAfterCommit = true;
    },
    clearThrowAfterCommit: () => {
      throwAfterCommit = false;
    },
    failFirstReadback: () => {
      failFirstReadback = true;
    },
    failFirstMediaResponse: () => {
      failFirstMediaResponse = true;
    },
    mutatePersistedFields: () => {
      persistedFieldsHash = "9".repeat(64);
    },
    commitCalls: () => commitCalls,
    mediaCalls: () => mediaCalls,
    mediaSideEffects: () => mediaSideEffects,
    mediaInputs: () => mediaInputs,
    prepared: () => prepared
  };
}

async function compileAndApprove(
  env: ReturnType<typeof harness>
): Promise<GutenbergV2Approval> {
  const candidate = await env.service.compileCandidate({
    executionId: "execution-1",
    idempotencyKey: "key-1",
    plan: plan()
  });
  const approval: GutenbergV2Approval = {
    schemaVersion: "sitepilot.approval/v2",
    approvalId: "approval-1",
    approverId: "approver-1",
    approvedAt: env.clockState.value.toISOString(),
    expiresAt: new Date(
      env.clockState.value.getTime() + 60 * 60 * 1_000
    ).toISOString(),
    binding: createGutenbergV2ApprovalBinding(candidate)
  };
  await env.service.recordApproval({ executionId: "execution-1", approval });
  return approval;
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("GutenbergV2ContentService", () => {
  it("reads existing post source through the trusted transport and rejects mismatched identity", async () => {
    const env = harness();
    const source: GutenbergV2SourceSnapshot = {
      schemaVersion: "sitepilot.source-snapshot/v2",
      siteId: "site-1",
      postId: 42,
      postType: "post",
      revision: "revision-1",
      rawContent: content,
      contentHash: hashGutenbergV2Content(content),
      fields: expectedFields,
      fieldsHash: hashGutenbergV2Value(expectedFields),
      blockTreeFingerprint: "5".repeat(64),
      blockIndex: []
    };
    vi.mocked(env.wordpress.readSource).mockResolvedValueOnce(source);
    await expect(
      env.service.readSource({ siteId: "site-1", postType: "post", postId: 42 })
    ).resolves.toEqual(source);
    vi.mocked(env.wordpress.readSource).mockResolvedValueOnce({
      ...source,
      postId: 43
    });
    await expect(
      env.service.readSource({ siteId: "site-1", postType: "post", postId: 42 })
    ).rejects.toMatchObject({ code: "runtime_changed" });
  });

  it("records an exact review rejection and makes revision requests terminal until regeneration", async () => {
    const env = harness();
    const candidate = await env.service.compileCandidate({
      executionId: "execution-1",
      idempotencyKey: "key-1",
      plan: plan()
    });
    await expect(
      env.service.rejectCandidate({
        executionId: "execution-1",
        candidateId: `${candidate.candidateId}-other`
      })
    ).rejects.toMatchObject({ code: "approval_invalid" });
    await expect(
      env.service.rejectCandidate({
        executionId: "execution-1",
        candidateId: candidate.candidateId
      })
    ).resolves.toMatchObject({ state: "rejected" });
    await expect(
      env.service.recordApproval({
        executionId: "execution-1",
        approval: {
          schemaVersion: "sitepilot.approval/v2",
          approvalId: "approval-after-reject",
          approverId: "approver-1",
          approvedAt: env.clockState.value.toISOString(),
          expiresAt: new Date(
            env.clockState.value.getTime() + 60_000
          ).toISOString(),
          binding: createGutenbergV2ApprovalBinding(candidate)
        }
      })
    ).rejects.toMatchObject({ code: "approval_invalid" });
  });

  it("uses SQLite CAS across connections and reloads immutable approvals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-gutenberg-v2-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "journal.sqlite");
    const firstConnection = new Database(filePath);
    const secondConnection = new Database(filePath);
    connections.push(firstConnection, secondConnection);
    const first = new SqliteGutenbergV2ExecutionJournal(firstConnection);
    const second = new SqliteGutenbergV2ExecutionJournal(secondConnection);
    const now = "2026-09-22T12:00:00.000Z";
    const base = {
      schemaVersion: "sitepilot.execution-journal/v2" as const,
      executionId: "cas-execution",
      idempotencyKey: "cas-key",
      siteId: "site-1",
      planHash: "8".repeat(64),
      state: "planned" as const,
      revision: 0,
      createdAt: now,
      updatedAt: now
    };
    await first.create(base);
    const next = { ...base, state: "compiling" as const, revision: 1 };
    const outcomes = await Promise.all([
      first.compareAndSet({
        executionId: base.executionId,
        expectedRevision: 0,
        expectedState: "planned",
        next
      }),
      second.compareAndSet({
        executionId: base.executionId,
        expectedRevision: 0,
        expectedState: "planned",
        next
      })
    ]);
    expect(outcomes.sort()).toEqual([false, true]);

    const approvalStores = [
      new SqliteGutenbergV2ApprovalStore(firstConnection),
      new SqliteGutenbergV2ApprovalStore(secondConnection)
    ];
    const candidate = await harness().service.compileCandidate({
      executionId: "execution-1",
      idempotencyKey: "key-1",
      plan: plan()
    });
    const approval: GutenbergV2Approval = {
      schemaVersion: "sitepilot.approval/v2",
      approvalId: "approval-reload",
      approverId: "approver-1",
      approvedAt: now,
      expiresAt: "2026-09-22T13:00:00.000Z",
      binding: createGutenbergV2ApprovalBinding(candidate)
    };
    await approvalStores[0]!.save(approval);
    expect(await approvalStores[1]!.get(approval.approvalId)).toEqual(approval);
  });

  it("persists an idempotent state machine through successful verification", async () => {
    const env = harness();
    await compileAndApprove(env);
    const result = await env.service.executeApprovedCandidate({
      executionId: "execution-1"
    });
    expect(result.state).toBe("succeeded");
    expect((await env.journal.get("execution-1"))?.state).toBe("succeeded");
    expect(env.commitCalls()).toBe(1);
  });

  it("rehashes staged media and reuses the same durable binding identity on retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepilot-v2-media-"));
    temporaryDirectories.push(directory);
    const stagedAssets = new FileGutenbergV2StagedAssetStore(directory);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const staged = await stagedAssets.stage({
      bytes: png,
      mediaType: "image/png"
    });
    const env = harness();
    const mediaPlan: GutenbergV2BlockPlan = {
      ...plan(),
      media: [
        {
          ref: "hero-image",
          source: {
            kind: "staged_asset",
            stagedAssetId: staged.stagedAssetId,
            checksum: staged.checksum,
            mediaType: staged.mediaType,
            byteLength: staged.byteLength
          },
          alt: "Approved alt text"
        }
      ]
    };
    const candidate = await env.service.compileCandidate({
      executionId: "media-execution",
      idempotencyKey: "media-key",
      plan: mediaPlan
    });
    const approval: GutenbergV2Approval = {
      schemaVersion: "sitepilot.approval/v2",
      approvalId: "media-approval",
      approverId: "approver-1",
      approvedAt: "2026-09-22T12:00:00.000Z",
      expiresAt: "2026-09-22T13:00:00.000Z",
      binding: createGutenbergV2ApprovalBinding(candidate)
    };
    const requests: unknown[] = [];
    const transport = {
      resolveMediaBindings: vi.fn(async (request) => {
        requests.push(request);
        return {
          schemaVersion: "sitepilot.media-bindings-response/v2" as const,
          mapping: [
            {
              ref: "hero-image",
              approvedChecksum: staged.checksum,
              finalChecksum: staged.checksum,
              attachmentId: 88,
              url: "https://example.test/wp-content/uploads/hero.png"
            }
          ],
          createdMediaIds: [88]
        };
      })
    };
    const media = new DurableGutenbergV2MediaService({
      stagedAssets,
      transport
    });

    const input = {
      executionId: "media-execution",
      idempotencyKey: "media-key",
      candidate,
      approval
    };
    expect(await media.resolveForCommit(input)).toMatchObject({
      createdMediaIds: [88]
    });
    expect(await media.resolveForCommit(input)).toMatchObject({
      createdMediaIds: [88]
    });
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({
      items: [
        {
          ref: "hero-image",
          stagedAssetId: staged.stagedAssetId,
          approvedChecksum: staged.checksum,
          alt: "Approved alt text"
        }
      ]
    });
  });

  it("reconciles a lost commit response without issuing a duplicate write", async () => {
    const env = harness();
    await compileAndApprove(env);
    await env.service.prepareCommit({ executionId: "execution-1" });
    env.setThrowAfterCommit();
    await expect(
      env.service.commitCandidate({ executionId: "execution-1" })
    ).rejects.toMatchObject({
      code: "conditional_commit_failed",
      retryable: true
    });
    expect((await env.journal.get("execution-1"))?.state).toBe("committing");
    env.clearThrowAfterCommit();
    const receipt = await env.service.commitCandidate({
      executionId: "execution-1"
    });
    expect(receipt.disposition).toBe("reconciled");
    expect(env.commitCalls()).toBe(1);
  });

  it("retries a lost media response in preparing with the same durable identity", async () => {
    const env = harness();
    await compileAndApprove(env);
    env.failFirstMediaResponse();
    await expect(
      env.service.prepareCommit({ executionId: "execution-1" })
    ).rejects.toMatchObject({ code: "editor_unavailable", retryable: true });
    const pending = await env.journal.get("execution-1");
    expect(pending).toMatchObject({
      state: "preparing",
      failure: {
        code: "editor_unavailable",
        phase: "prepare"
      }
    });
    expect(pending?.failure?.message).toContain(
      "same execution and idempotency identifiers"
    );

    await env.service.prepareCommit({ executionId: "execution-1" });
    expect(env.mediaCalls()).toBe(2);
    expect(env.mediaSideEffects()).toBe(1);
    expect(env.mediaInputs()[0]).toEqual(env.mediaInputs()[1]);
    expect((await env.journal.get("execution-1"))?.state).toBe("preparing");
  });

  it("refuses a commit when approval expires after preparation", async () => {
    const env = harness();
    await compileAndApprove(env);
    await env.service.prepareCommit({ executionId: "execution-1" });
    env.clockState.value = new Date("2026-09-22T13:30:00.000Z");
    await expect(
      env.service.commitCandidate({ executionId: "execution-1" })
    ).rejects.toBeInstanceOf(GutenbergV2ServiceError);
    expect(env.commitCalls()).toBe(0);
    expect((await env.journal.get("execution-1"))?.state).toBe(
      "stale_approval"
    );
  });

  it("does not report success when persisted post fields differ from server preparation", async () => {
    const env = harness();
    await compileAndApprove(env);
    await env.service.prepareCommit({ executionId: "execution-1" });
    env.mutatePersistedFields();
    const receipt = await env.service.commitCandidate({
      executionId: "execution-1"
    });
    const result = await env.service.verifyPersistedContent({
      executionId: "execution-1",
      receipt
    });
    expect(result.state).toBe("post_write_verification_failed");
    expect((await env.journal.get("execution-1"))?.state).toBe(
      "post_write_verification_failed"
    );
  });

  it("keeps a recorded write in verifying state and resumes verification", async () => {
    const env = harness();
    await compileAndApprove(env);
    await env.service.prepareCommit({ executionId: "execution-1" });
    const receipt = await env.service.commitCandidate({
      executionId: "execution-1"
    });
    env.failFirstReadback();
    await expect(
      env.service.verifyPersistedContent({
        executionId: "execution-1",
        receipt
      })
    ).rejects.toMatchObject({ code: "verification_failed", retryable: true });
    expect((await env.journal.get("execution-1"))?.state).toBe("verifying");
    const result = await env.service.executeApprovedCandidate({
      executionId: "execution-1"
    });
    expect(result.state).toBe("succeeded");
  });

  it("routes deterministic media verification failure through the post-write lifecycle", async () => {
    const env = harness();
    await compileAndApprove(env);
    await env.service.prepareCommit({ executionId: "execution-1" });
    const receipt = await env.service.commitCandidate({
      executionId: "execution-1"
    });
    vi.mocked(env.worker.verifyPersistedContent).mockRejectedValueOnce(
      Object.assign(new Error("Approved image bytes changed."), {
        code: "media_changed",
        retryable: false,
        issues: [
          {
            code: "media_changed" as const,
            severity: "error" as const,
            phase: "verify" as const,
            message: "Approved image bytes changed."
          }
        ]
      })
    );

    const result = await env.service.verifyPersistedContent({
      executionId: "execution-1",
      receipt
    });
    expect(result.state).toBe("post_write_verification_failed");
    expect(result.verification?.issues).toContainEqual(
      expect.objectContaining({ code: "media_changed", phase: "verify" })
    );
    expect((await env.journal.get("execution-1"))?.state).toBe(
      "post_write_verification_failed"
    );
  });

  it("keeps transient editor verification failures retryable", async () => {
    const env = harness();
    await compileAndApprove(env);
    await env.service.prepareCommit({ executionId: "execution-1" });
    const receipt = await env.service.commitCandidate({
      executionId: "execution-1"
    });
    vi.mocked(env.worker.verifyPersistedContent).mockRejectedValueOnce(
      Object.assign(new Error("Editor session became unavailable."), {
        code: "editor_unavailable",
        retryable: true
      })
    );

    await expect(
      env.service.verifyPersistedContent({
        executionId: "execution-1",
        receipt
      })
    ).rejects.toMatchObject({ code: "verification_failed", retryable: true });
    expect((await env.journal.get("execution-1"))?.state).toBe("verifying");
    expect(
      (
        await env.service.executeApprovedCandidate({
          executionId: "execution-1"
        })
      ).state
    ).toBe("succeeded");
  });
});

describe("buildLlmGutenbergV2Plan", () => {
  it("binds scoped paths to trusted source fingerprints outside the model", async () => {
    const source: GutenbergV2SourceSnapshot = {
      schemaVersion: "sitepilot.source-snapshot/v2",
      siteId: "site-1",
      postId: 42,
      postType: "post",
      revision: "revision-1",
      rawContent: content,
      contentHash: hashGutenbergV2Content(content),
      fields: expectedFields,
      fieldsHash: hashGutenbergV2Value(expectedFields),
      blockTreeFingerprint: "5".repeat(64),
      blockIndex: [
        {
          path: [0],
          name: "core/paragraph",
          fingerprint: "6".repeat(64)
        }
      ]
    };
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        operations: [
          {
            type: "edit_block",
            targetPath: [0],
            expectedFingerprint: "model-cannot-control-this",
            replacement: {
              ref: "paragraph-replacement",
              name: "core/paragraph",
              attributes: { content: "Updated copy" },
              children: []
            }
          }
        ]
      }),
      usage: { inputTokens: 10, outputTokens: 20 }
    }));

    const result = await buildLlmGutenbergV2Plan({
      request: "Update the first paragraph.",
      siteId: "site-1",
      target: { operation: "apply_operations", source },
      capabilities: capabilities(),
      client: { providerId: "private-provider", complete },
      model: "private-model"
    });

    expect(result.plan.operation).toBe("apply_operations");
    if (result.plan.operation !== "apply_operations") {
      throw new Error("Expected an apply_operations plan.");
    }
    expect(result.plan.operations[0]).toMatchObject({
      id: "operation-1",
      target: {
        path: [0],
        expectedFingerprint: source.blockIndex[0]!.fingerprint
      }
    });
    expect(result.plan.target).toMatchObject({
      postId: source.postId,
      sourceRevision: source.revision,
      sourceContentHash: source.contentHash
    });
    expect(result.usage.provider).toBe("private-provider");
  });
});
