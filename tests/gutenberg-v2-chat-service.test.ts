import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "@sitepilot/repositories";
import type { RequestId, SiteId } from "@sitepilot/domain";
import { FileGutenbergV2StagedAssetStore } from "@sitepilot/services";
import {
  hashGutenbergV2Content,
  hashGutenbergV2Value
} from "@sitepilot/services";
import {
  configureRuntimeContext,
  resetRuntimeContext
} from "../apps/desktop/src/main/runtime-context.js";
import {
  configureGutenbergV2PlannerFactory,
  configureGutenbergV2ProtocolProbe,
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  generateGutenbergV2Candidate,
  getGutenbergV2RequestState,
  getGutenbergV2ReviewArtifact,
  hasGutenbergV2RequestMapping,
  claimV1RequestEngine
} from "../apps/desktop/src/main/gutenberg-v2-chat-service.js";
import { configureGutenbergV2RuntimeFactory } from "../apps/desktop/src/main/gutenberg-v2-runtime-service.js";

const temporary: string[] = [];
const databases: ReturnType<typeof initializeDatabase>[] = [];

function storage(values: Map<string, string>) {
  return {
    get: vi.fn(async (key: { namespace: string; keyId: string }) =>
      values.get(`${key.namespace}:${key.keyId}`)
    ),
    set: vi.fn(
      async (key: { namespace: string; keyId: string }, value: string) => {
        values.set(`${key.namespace}:${key.keyId}`, value);
      }
    ),
    delete: vi.fn(async (key: { namespace: string; keyId: string }) => {
      values.delete(`${key.namespace}:${key.keyId}`);
    }),
    has: vi.fn(async (key: { namespace: string; keyId: string }) =>
      values.has(`${key.namespace}:${key.keyId}`)
    )
  };
}

function setup(enabled: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "sitepilot-v2-chat-"));
  temporary.push(directory);
  const database = initializeDatabase({
    filePath: join(directory, "sitepilot.sqlite")
  });
  databases.push(database);
  const values = new Map<string, string>([
    [
      "app:planner_settings:site:site-1",
      JSON.stringify({ gutenbergV2Enabled: enabled })
    ],
    ["site:site-1", Buffer.from("test-secret").toString("base64")]
  ]);
  const secureStorage = storage(values);
  configureRuntimeContext({ database, secureStorage, userDataPath: directory });
  const now = new Date().toISOString();
  database.connection
    .prepare(
      `INSERT INTO workspaces (id,name,slug,owner_user_profile_id,created_at,updated_at) VALUES ('workspace-1','Workspace','workspace-1','user-1',@now,@now)`
    )
    .run({ now });
  database.connection
    .prepare(
      `INSERT INTO user_profiles (id,workspace_id,display_name,app_role,created_at,updated_at) VALUES ('user-1','workspace-1','User','owner',@now,@now)`
    )
    .run({ now });
  database.connection
    .prepare(
      `INSERT INTO sites (id,workspace_id,name,base_url,environment,activation_status,created_at,updated_at) VALUES ('site-1','workspace-1','Site','https://example.test','development','active',@now,@now)`
    )
    .run({ now });
  database.connection
    .prepare(
      `INSERT INTO site_connections (id,site_id,status,protocol_version,plugin_version,client_identifier,trusted_app_origin,created_at,updated_at) VALUES ('connection-1','site-1','verified','2','2','client-1','https://app.test',@now,@now)`
    )
    .run({ now });
  database.connection
    .prepare(
      `INSERT INTO chat_threads (id,site_id,title,type,created_at,updated_at) VALUES ('thread-1','site-1','Thread','content_creation',@now,@now)`
    )
    .run({ now });
  database.connection
    .prepare(
      `INSERT INTO requests (id,site_id,thread_id,requested_by_json,status,user_prompt,attachments_json,created_at,updated_at) VALUES ('request-1','site-1','thread-1','{"userProfileId":"user-1","appRole":"owner","siteRoles":[]}','new','Create a draft','[]',@now,@now)`
    )
    .run({ now });
  return { database, secureStorage };
}

function sourceSnapshot() {
  const rawContent = "<!-- wp:paragraph --><p>Source</p><!-- /wp:paragraph -->";
  const fields = { title: "Existing", excerpt: "", status: "draft" };
  return {
    schemaVersion: "sitepilot.source-snapshot/v2" as const,
    siteId: "site-1",
    postId: 42,
    postType: "post" as const,
    revision: "revision-1",
    rawContent,
    contentHash: hashGutenbergV2Content(rawContent),
    fields,
    fieldsHash: hashGutenbergV2Value(fields),
    blockTreeFingerprint: "1".repeat(64),
    blockIndex: []
  };
}

function configureFakeRuntime() {
  const jobs = new Map<string, any>();
  const plans: any[] = [];
  const approvals: any[] = [];
  let executeCalls = 0;
  let largeArtifact = false;
  const source = sourceSnapshot();
  const validReport = (intentHash: string) => ({
    outcome: "valid" as const,
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
  });
  const content = {
    discoverCapabilities: vi.fn(async () => ({
      schemaVersion: "sitepilot.editor-capabilities/v2" as const,
      siteId: "site-1",
      siteUrl: "https://example.test",
      bridgeVersion: "2",
      wordpressVersion: "7",
      fingerprint: "2".repeat(64),
      capturedAt: new Date().toISOString(),
      context: {
        postType: "post" as const,
        userId: 1,
        userRoles: ["editor"],
        theme: "theme",
        pluginFingerprint: "3".repeat(64),
        editorSettingsFingerprint: "4".repeat(64)
      },
      blocks: [
        {
          name: "core/paragraph",
          registered: true,
          allowed: true,
          v2Support: "author" as const,
          dynamic: false,
          attributeSchemaHash: "5".repeat(64),
          allowedParents: [],
          allowedAncestors: [],
          allowedChildren: [],
          supportsHtml: false,
          lock: "none" as const
        }
      ]
    })),
    compileCandidate: vi.fn(
      async ({ executionId, idempotencyKey, plan }: any) => {
        plans.push(plan);
        const serializedContent =
          "<!-- wp:paragraph --><p>Generated</p><!-- /wp:paragraph -->";
        const intentHash = hashGutenbergV2Value(plan);
        const candidate = {
          schemaVersion: "sitepilot.compiled-candidate/v2",
          candidateId: `candidate-${executionId}`,
          planId: plan.planId,
          siteId: "site-1",
          operation: plan.operation,
          intent: plan,
          requestedPostFields: {
            ...(plan.postFields?.title ? { title: plan.postFields.title } : {}),
            ...(plan.postFields?.excerpt
              ? { excerpt: plan.postFields.excerpt }
              : {}),
            ...(plan.postFields?.status
              ? { status: plan.postFields.status }
              : {})
          },
          serializedContent,
          contentHash: hashGutenbergV2Content(serializedContent),
          intentHash,
          requestedFieldsHash: hashGutenbergV2Value(plan.postFields ?? {}),
          sourceState: {
            ...(plan.operation === "create_draft"
              ? {}
              : {
                  postId: 42,
                  revision: source.revision,
                  contentHash: source.contentHash
                }),
            affectedFieldsHash: hashGutenbergV2Value({})
          },
          capabilityFingerprint: "2".repeat(64),
          mediaManifest: (plan.media ?? []).map((media: any) => ({
            ref: media.ref,
            approvedChecksum: media.source.checksum,
            alt: media.alt
          })),
          mediaManifestHash: hashGutenbergV2Value(plan.media ?? []),
          validation: validReport(intentHash),
          reviewArtifact: {
            structureDiffRef: "artifact://structure",
            previewRefs: ["artifact://preview"]
          },
          compiledAt: new Date().toISOString()
        };
        jobs.set(executionId, {
          executionId,
          idempotencyKey,
          siteId: "site-1",
          state: "review_ready",
          candidate,
          revision: 1
        });
        return candidate;
      }
    ),
    recordApproval: vi.fn(async ({ executionId, approval }: any) => {
      approvals.push(approval);
      const job = jobs.get(executionId);
      if (job.state === "approved") {
        if (job.approvalId !== approval.approvalId)
          throw new Error("approval cannot be rebound");
        return job;
      }
      job.state = "approved";
      job.approval = approval;
      job.approvalId = approval.approvalId;
      return job;
    }),
    rejectCandidate: vi.fn(async ({ executionId, candidateId }: any) => {
      const job = jobs.get(executionId);
      if (job.candidate.candidateId !== candidateId)
        throw new Error("candidate mismatch");
      job.state = "rejected";
      return job;
    }),
    executeApprovedCandidate: vi.fn(async ({ executionId }: any) => {
      const job = jobs.get(executionId);
      if (job.result) return job.result;
      executeCalls += 1;
      job.state = "succeeded";
      job.result = {
        schemaVersion: "sitepilot.execution-result/v2",
        executionId,
        idempotencyKey: job.idempotencyKey,
        state: "succeeded",
        postId: 42,
        persistedRevision: "revision-2",
        persistedContentHash: "1".repeat(64),
        persistedFieldsHash: "2".repeat(64),
        verification: validReport(job.candidate.intentHash),
        beforeStateRef: "before",
        createdMediaIds: [],
        retry: { retryable: false },
        rollback: { attempted: false, outcome: "not_required" },
        auditRef: `execution:${executionId}`,
        completedAt: new Date().toISOString()
      };
      return job.result;
    })
  };
  const runtime = {
    content,
    stagedAssets: new FileGutenbergV2StagedAssetStore(
      join(temporary[temporary.length - 1]!, "staged")
    ),
    journal: {
      get: vi.fn(async (executionId: string) => jobs.get(executionId) ?? null)
    } as any,
    readSource: vi.fn(async () => source),
    readReviewArtifact: vi.fn(async () =>
      largeArtifact ? Buffer.alloc(20 * 1024 * 1024 + 1) : Buffer.from("{}")
    ),
    close: vi.fn(async () => undefined)
  };
  configureGutenbergV2RuntimeFactory(() => runtime as any);
  return {
    jobs,
    plans,
    approvals,
    runtime,
    executeCalls: () => executeCalls,
    setLargeArtifact: () => {
      largeArtifact = true;
    },
    source
  };
}

function configureDeterministicPlanner(
  onComplete?: () => Promise<void> | void
): void {
  configureGutenbergV2PlannerFactory(async () => ({
    ok: true as const,
    model: "test-model",
    client: {
      providerId: "test",
      complete: vi.fn(async () => {
        await onComplete?.();
        return {
          text: JSON.stringify({
            postFields: { title: "Generated" },
            blocks: [
              {
                ref: "p1",
                name: "core/paragraph",
                attributes: { content: "Generated" },
                children: []
              }
            ]
          }),
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      })
    }
  }));
}

afterEach(() => {
  resetRuntimeContext();
  configureGutenbergV2PlannerFactory(undefined);
  configureGutenbergV2ProtocolProbe(undefined);
  configureGutenbergV2RuntimeFactory(undefined);
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("desktop Gutenberg v2 chat boundary", () => {
  it("enforces the local gate before planner selection", async () => {
    setup(false);
    const planner = vi.fn();
    configureGutenbergV2PlannerFactory(async () => {
      planner();
      throw new Error("planner must not run");
    });
    const result = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    expect(result).toMatchObject({ code: "gutenberg_v2_not_enabled" });
    expect(planner).not.toHaveBeenCalled();
  });

  it("enforces the destination gate before planner selection", async () => {
    setup(true);
    configureGutenbergV2ProtocolProbe(async () => false);
    const planner = vi.fn();
    configureGutenbergV2PlannerFactory(async () => {
      planner();
      throw new Error("planner must not run");
    });
    const result = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    expect(result).toMatchObject({ code: "gutenberg_v2_destination_disabled" });
    expect(planner).not.toHaveBeenCalled();
  });

  it("rejects requests already owned by v1 before runtime or planner work", async () => {
    const { database } = setup(true);
    configureGutenbergV2ProtocolProbe(async () => true);
    database.connection
      .prepare(
        "UPDATE requests SET latest_plan_id = 'legacy-plan' WHERE id = 'request-1'"
      )
      .run();
    const planner = vi.fn();
    configureGutenbergV2PlannerFactory(async () => {
      planner();
      throw new Error("planner must not run");
    });
    const result = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    expect(result).toMatchObject({ code: "request_engine_conflict" });
    expect(planner).not.toHaveBeenCalled();
  });

  it("detects a durable v2 mapping so both v1 entry points can refuse it", async () => {
    const { database } = setup(true);
    const columns = database.connection
      .prepare("PRAGMA table_info(gutenberg_v2_request_executions)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["idempotency_key", "decision"])
    );
    const foreignKeys = database.connection
      .prepare("PRAGMA foreign_key_list(gutenberg_v2_request_executions)")
      .all() as Array<{ table: string }>;
    expect(foreignKeys.map((key) => key.table)).toEqual(
      expect.arrayContaining(["requests", "sites"])
    );
    expect(
      hasGutenbergV2RequestMapping("site-1" as SiteId, "request-1" as RequestId)
    ).toBe(false);
    database.connection
      .prepare(
        `INSERT INTO gutenberg_v2_request_executions (request_id,site_id,execution_id,idempotency_key,target_json,decision,created_at,updated_at) VALUES ('request-1','site-1','execution-1','key-1','{"operation":"create_draft","postType":"post"}',NULL,@now,@now)`
      )
      .run({ now: new Date().toISOString() });
    expect(
      hasGutenbergV2RequestMapping("site-1" as SiteId, "request-1" as RequestId)
    ).toBe(true);
    expect(
      claimV1RequestEngine("site-1" as SiteId, "request-1" as RequestId)
    ).toBe(false);
    database.connection
      .prepare(
        "INSERT INTO requests (id,site_id,thread_id,requested_by_json,status,user_prompt,attachments_json,created_at,updated_at,content_engine) SELECT 'request-2',site_id,thread_id,requested_by_json,'new','v1 owned',attachments_json,created_at,updated_at,'v1' FROM requests WHERE id='request-1'"
      )
      .run();
    configureGutenbergV2ProtocolProbe(async () => true);
    const v2Conflict = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-2" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    expect(v2Conflict).toMatchObject({ code: "request_engine_conflict" });
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO gutenberg_v2_request_executions (request_id,site_id,execution_id,idempotency_key,target_json,decision,created_at,updated_at) VALUES ('request-2','site-1','execution-1','key-2','{"operation":"create_draft","postType":"post"}',NULL,@now,@now)`
        )
        .run({ now: new Date().toISOString() })
    ).toThrow();
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO gutenberg_v2_request_executions (request_id,site_id,execution_id,idempotency_key,target_json,decision,created_at,updated_at) VALUES ('request-2','site-1','execution-2','key-1','{"operation":"create_draft","postType":"post"}',NULL,@now,@now)`
        )
        .run({ now: new Date().toISOString() })
    ).toThrow();
    const targetConflict = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "replace_content", postType: "post", postId: 42 }
    });
    expect(targetConflict).toMatchObject({ code: "target_mismatch" });
  });

  it("does not throw when an imported mapping has an invalid target payload", async () => {
    const { database } = setup(true);
    database.connection
      .prepare(
        `INSERT INTO gutenberg_v2_request_executions (request_id,site_id,execution_id,idempotency_key,target_json,decision,created_at,updated_at) VALUES ('request-1','site-1','execution-invalid','key-invalid','{}',NULL,@now,@now)`
      )
      .run({ now: new Date().toISOString() });
    await expect(
      getGutenbergV2RequestState({
        siteId: "site-1" as SiteId,
        requestId: "request-1" as RequestId
      })
    ).resolves.toEqual({ ok: true, state: null });
  });

  it("stages attachments and passes immutable media plus trusted source to the planner", async () => {
    const { database } = setup(true);
    configureGutenbergV2ProtocolProbe(async () => true);
    const state = configureFakeRuntime();
    const plannerMessages: any[] = [];
    configureGutenbergV2PlannerFactory(async () => ({
      ok: true as const,
      model: "test-model",
      client: {
        providerId: "test",
        complete: vi.fn(async (messages: any[]) => {
          plannerMessages.push(messages);
          return {
            text: JSON.stringify({
              postFields: { title: "Generated" },
              blocks: [
                {
                  ref: "p1",
                  name: "core/paragraph",
                  attributes: { content: "Generated" },
                  children: []
                }
              ]
            }),
            usage: { inputTokens: 1, outputTokens: 1 }
          };
        })
      }
    }));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    database.connection
      .prepare(
        "UPDATE requests SET attachments_json = @attachments WHERE id = 'request-1'"
      )
      .run({
        attachments: JSON.stringify([
          {
            fileName: "hero.png",
            mediaType: "image/png",
            sizeBytes: bytes.length,
            dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
          }
        ])
      });
    const created = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    expect(created).toMatchObject({ ok: true });
    expect(state.plans[0].media[0].source.kind).toBe("staged_asset");
    expect(state.plans[0].media[0].source.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(state.plans[0].media[0].source.byteLength).toBe(bytes.length);
    const context = JSON.parse(plannerMessages[0][1].content);
    expect(context.media[0].source.checksum).toBe(
      state.plans[0].media[0].source.checksum
    );

    database.connection
      .prepare(
        "INSERT INTO requests (id,site_id,thread_id,requested_by_json,status,user_prompt,attachments_json,created_at,updated_at) SELECT 'request-2',site_id,thread_id,requested_by_json,'new','Update existing',attachments_json,created_at,updated_at FROM requests WHERE id='request-1'"
      )
      .run();
    const existing = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-2" as RequestId,
      target: { operation: "replace_content", postType: "post", postId: 42 }
    });
    expect(existing).toMatchObject({ ok: true });
    const existingContext = JSON.parse(plannerMessages[1][1].content);
    expect(existingContext.source.postId).toBe(42);
    expect(state.plans[1].target.sourceRevision).toBe(state.source.revision);
    database.connection
      .prepare(
        "INSERT INTO requests (id,site_id,thread_id,requested_by_json,status,user_prompt,attachments_json,created_at,updated_at) SELECT 'request-3',site_id,thread_id,requested_by_json,'new','Mismatched source',attachments_json,created_at,updated_at FROM requests WHERE id='request-1'"
      )
      .run();
    state.runtime.readSource.mockResolvedValue({
      ...state.source,
      postId: 999
    });
    const mismatched = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-3" as RequestId,
      target: { operation: "replace_content", postType: "post", postId: 42 }
    });
    expect(mismatched).toMatchObject({ code: "runtime_changed" });
  });

  it("preserves exact approval, rejection feedback, status and audit transitions", async () => {
    const { database } = setup(true);
    database.connection
      .prepare(
        "INSERT INTO requests (id,site_id,thread_id,requested_by_json,status,user_prompt,attachments_json,created_at,updated_at) SELECT 'request-2',site_id,thread_id,requested_by_json,'new','Revision',attachments_json,created_at,updated_at FROM requests WHERE id='request-1'"
      )
      .run();
    configureGutenbergV2ProtocolProbe(async () => true);
    configureFakeRuntime();
    configureGutenbergV2PlannerFactory(async () => ({
      ok: true as const,
      model: "test",
      client: {
        providerId: "test",
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            postFields: { title: "Generated" },
            blocks: [
              {
                ref: "p1",
                name: "core/paragraph",
                attributes: { content: "Generated" },
                children: []
              }
            ]
          }),
          usage: { inputTokens: 1, outputTokens: 1 }
        }))
      }
    }));
    const first = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    const firstCandidate = (first as any).state.candidate.candidateId;
    const approved = await decideGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      candidateId: firstCandidate,
      decision: "approved"
    });
    expect(approved).toMatchObject({ ok: true, state: { state: "approved" } });
    database.connection
      .prepare(
        "UPDATE gutenberg_v2_request_executions SET decision = NULL WHERE request_id = 'request-1'"
      )
      .run();
    const retriedApproval = await decideGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      candidateId: firstCandidate,
      decision: "approved"
    });
    expect(retriedApproval).toMatchObject({
      ok: true,
      state: { state: "approved" }
    });
    await expect(
      database.repositories.requests.getById("request-1" as RequestId)
    ).resolves.toMatchObject({ status: "approved" });
    const second = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-2" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    const secondCandidate = (second as any).state.candidate.candidateId;
    const revision = await decideGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-2" as RequestId,
      candidateId: secondCandidate,
      decision: "revision_requested",
      note: "Change the opening copy."
    });
    expect(revision).toMatchObject({ ok: true, state: { state: "rejected" } });
    await expect(
      database.repositories.requests.getById("request-2" as RequestId)
    ).resolves.toMatchObject({ status: "drafted" });
    const audits = await database.repositories.auditEntries.listByRequestId(
      "request-2" as RequestId
    );
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "approval_requested" }),
        expect.objectContaining({
          eventType: "approval_decided",
          metadata: expect.objectContaining({
            note: "Change the opening copy."
          })
        })
      ])
    );
  });

  it("reuses the durable result on repeated execute and authorizes artifacts", async () => {
    const { database } = setup(true);
    configureGutenbergV2ProtocolProbe(async () => true);
    const state = configureFakeRuntime();
    configureGutenbergV2PlannerFactory(async () => ({
      ok: true as const,
      model: "test",
      client: {
        providerId: "test",
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            postFields: { title: "Generated" },
            blocks: [
              {
                ref: "p1",
                name: "core/paragraph",
                attributes: { content: "Generated" },
                children: []
              }
            ]
          }),
          usage: { inputTokens: 1, outputTokens: 1 }
        }))
      }
    }));
    const generated = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    const candidateId = (generated as any).state.candidate.candidateId;
    await decideGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      candidateId,
      decision: "approved"
    });
    const first = await executeGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId
    });
    const second = await executeGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId
    });
    expect(first).toMatchObject({ ok: true, state: { state: "succeeded" } });
    expect(second).toMatchObject({ ok: true, state: { state: "succeeded" } });
    expect(state.executeCalls()).toBe(1);
    expect(
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM gutenberg_v2_request_executions WHERE request_id='request-1'"
        )
        .get()
    ).toMatchObject({ count: 1 });
    const denied = await getGutenbergV2ReviewArtifact({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      artifactId: "../secret"
    });
    expect(denied).toMatchObject({ code: "artifact_not_found" });
    state.setLargeArtifact();
    const oversized = await getGutenbergV2ReviewArtifact({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      artifactId: "structure"
    });
    expect(oversized).toMatchObject({ code: "request_too_large" });
  });

  it("serializes concurrent generation and resumes a claimed mapping with the same ids", async () => {
    const { database } = setup(true);
    configureGutenbergV2ProtocolProbe(async () => true);
    const state = configureFakeRuntime();
    let releasePlanner!: () => void;
    let enteredPlanner!: () => void;
    const plannerEntered = new Promise<void>((resolve) => {
      enteredPlanner = resolve;
    });
    const plannerReleased = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    let plannerCalls = 0;
    configureDeterministicPlanner(async () => {
      plannerCalls += 1;
      enteredPlanner();
      await plannerReleased;
    });
    const first = generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    await plannerEntered;
    const second = generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-1" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    const concurrent = Promise.all([first, second]);
    const secondResult = await second;
    expect(secondResult).toMatchObject({ code: "generation_in_progress" });
    releasePlanner();
    const [firstResult] = await concurrent;
    expect(firstResult).toMatchObject({ ok: true });
    expect(plannerCalls).toBe(1);
    expect(
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM gutenberg_v2_request_executions WHERE request_id='request-1'"
        )
        .get()
    ).toMatchObject({ count: 1 });
    expect(state.runtime.close).toHaveBeenCalled();

    const resumeDirectory = mkdtempSync(join(tmpdir(), "sitepilot-v2-resume-"));
    temporary.push(resumeDirectory);
    const resumeExecutionId = "execution-resume";
    const resumeIdempotencyKey = "idempotency-resume";
    database.connection
      .prepare(
        "INSERT INTO requests (id,site_id,thread_id,requested_by_json,status,user_prompt,attachments_json,content_engine,created_at,updated_at) SELECT 'request-resume',site_id,thread_id,requested_by_json,'new','Resume',attachments_json,'gutenberg_v2',created_at,updated_at FROM requests WHERE id='request-1'"
      )
      .run();
    database.connection
      .prepare(
        `INSERT INTO gutenberg_v2_request_executions (request_id,site_id,execution_id,idempotency_key,target_json,decision,created_at,updated_at) VALUES ('request-resume','site-1',@executionId,@idempotencyKey,'{"operation":"create_draft","postType":"post"}',NULL,@now,@now)`
      )
      .run({
        executionId: resumeExecutionId,
        idempotencyKey: resumeIdempotencyKey,
        now: new Date().toISOString()
      });
    configureFakeRuntime();
    configureDeterministicPlanner();
    const resumed = await generateGutenbergV2Candidate({
      siteId: "site-1" as SiteId,
      requestId: "request-resume" as RequestId,
      target: { operation: "create_draft", postType: "post" }
    });
    expect(resumed).toMatchObject({
      ok: true,
      state: { executionId: resumeExecutionId }
    });
    const resumedRow = database.connection
      .prepare(
        "SELECT execution_id AS executionId,idempotency_key AS idempotencyKey FROM gutenberg_v2_request_executions WHERE request_id='request-resume'"
      )
      .get() as { executionId: string; idempotencyKey: string };
    expect(resumedRow).toEqual({
      executionId: resumeExecutionId,
      idempotencyKey: resumeIdempotencyKey
    });
  });
});
