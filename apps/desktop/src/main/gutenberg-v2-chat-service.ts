import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  buildLlmGutenbergV2Plan,
  createGutenbergV2ApprovalBinding,
  GutenbergV2PlanGenerationError,
  GutenbergV2ServiceError,
  hashGutenbergV2Value,
  type GutenbergV2PlanningModelClient,
  type GutenbergV2PlanRevision
} from "@sitepilot/services";
import type {
  GutenbergV2CompiledCandidate,
  GutenbergV2JobRecord,
  ImageAttachmentPayload
} from "@sitepilot/contracts";
import type {
  AuditEntryId,
  ChatMessageId,
  RequestId,
  SiteId
} from "@sitepilot/domain";
import {
  createAnthropicChatClient,
  createOpenAiChatClient
} from "@sitepilot/provider-adapters";
import { z } from "zod";

import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import { DEFAULT_OPERATOR } from "./chat-service.js";
import {
  candidateReadyReport,
  decisionReport,
  executionReport,
  failureReport,
  friendlyCandidateReady,
  friendlyDecision,
  friendlyExecution,
  friendlyFailureFallback,
  parsePlainLanguage,
  plainLanguagePrompt,
  requestNotices
} from "./gutenberg-v2-report.js";
import { createGutenbergV2DesktopRuntime } from "./gutenberg-v2-runtime-service.js";
import { loadPlannerPreferences } from "./planner-preferences-service.js";
import { fetchSiteUrl } from "./site-fetch.js";

const targetSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create_draft"),
    postType: z.enum(["post", "page"])
  }),
  z.object({
    operation: z.literal("replace_content"),
    postType: z.enum(["post", "page"]),
    postId: z.number().int().positive()
  }),
  z.object({
    operation: z.literal("apply_operations"),
    postType: z.enum(["post", "page"]),
    postId: z.number().int().positive()
  })
]);
export type GutenbergV2Target = z.infer<typeof targetSchema>;

type Mapping = {
  requestId: string;
  siteId: string;
  executionId: string;
  idempotencyKey: string;
  target: GutenbergV2Target;
  decision: "approved" | "rejected" | "revision_requested" | null;
  createdAt: string;
  updatedAt: string;
};

function getOptionalConnection(): Database.Database | undefined {
  const database = getDatabase() as { connection?: Database.Database };
  return database.connection;
}

const protocolSchema = z.object({ v2: z.object({ enabled: z.boolean() }) });

type PlannerFactory = (input: {
  siteId: SiteId;
}) => Promise<
  | { ok: true; client: GutenbergV2PlanningModelClient; model: string }
  | { ok: false; code: string; message: string }
>;

let plannerFactoryForTests: PlannerFactory | undefined;
let protocolProbeForTests: ((siteUrl: string) => Promise<boolean>) | undefined;
const inFlightV2Generations = new Set<string>();

// Jobs that ended before anything was written: a new candidate may replace them.
const PRE_WRITE_TERMINAL_STATES = new Set([
  "rejected",
  "pre_write_failed",
  "stale_approval"
]);
// Jobs that wrote to the destination: the request is finished for v2.
const WRITTEN_STATES = new Set([
  "succeeded",
  "post_write_verification_failed",
  "rolled_back",
  "rollback_conflict",
  "manual_intervention_required"
]);
function previousPlanFrom(
  job: GutenbergV2JobRecord | null | undefined
): GutenbergV2PlanRevision["previousPlan"] | undefined {
  const intent = job?.candidate?.intent as Record<string, unknown> | undefined;
  if (!intent) return undefined;
  return {
    ...(intent.postFields === undefined
      ? {}
      : { postFields: intent.postFields }),
    ...(intent.blocks === undefined ? {} : { blocks: intent.blocks }),
    ...(intent.operations === undefined
      ? {}
      : { operations: intent.operations })
  };
}

/** Test seam: callers provide a deterministic planner, never a mock HTTP route. */
export function configureGutenbergV2PlannerFactory(
  factory: PlannerFactory | undefined
): void {
  plannerFactoryForTests = factory;
}

/** Test seam for the destination protocol gate; production probes the signed site URL. */
export function configureGutenbergV2ProtocolProbe(
  probe: ((siteUrl: string) => Promise<boolean>) | undefined
): void {
  protocolProbeForTests = probe;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorResult(error: unknown): {
  ok: false;
  code: string;
  message: string;
} {
  if (error instanceof GutenbergV2ServiceError) {
    return { ok: false, code: error.code, message: error.message };
  }
  if (error instanceof GutenbergV2PlanGenerationError) {
    return { ok: false, code: "planner_model_failed", message: error.message };
  }
  return {
    ok: false,
    code: "gutenberg_v2_failed",
    message: error instanceof Error ? error.message : "Gutenberg v2 failed."
  };
}

function reportableError(error: unknown): {
  message: string;
  code?: string;
  retryable?: boolean;
  issues?: readonly (GutenbergV2ServiceError["issues"][number] | string)[];
} {
  if (error instanceof GutenbergV2ServiceError) {
    return {
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      issues: error.issues
    };
  }
  if (error instanceof GutenbergV2PlanGenerationError) {
    return {
      message: error.message,
      code: "planner_model_failed",
      issues: error.issues
    };
  }
  return {
    message: error instanceof Error ? error.message : "Unknown failure."
  };
}

async function choosePlanner(siteId: SiteId): ReturnType<PlannerFactory> {
  if (plannerFactoryForTests) return plannerFactoryForTests({ siteId });
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site)
    return { ok: false, code: "site_not_found", message: "Site not found." };
  const storage = getSecureStorage();
  const preferences = await loadPlannerPreferences(storage, site.workspaceId);
  const openaiKey = await storage.get({
    namespace: "provider",
    keyId: "openai"
  });
  const anthropicKey = await storage.get({
    namespace: "provider",
    keyId: "anthropic"
  });
  const selected = preferences.preferredProvider;
  const openai = () =>
    openaiKey
      ? {
          ok: true as const,
          client: createOpenAiChatClient(openaiKey),
          model: preferences.openaiModel
        }
      : null;
  const anthropic = () =>
    anthropicKey
      ? {
          ok: true as const,
          client: createAnthropicChatClient(anthropicKey),
          model: preferences.anthropicModel
        }
      : null;
  const chosen =
    selected === "openai"
      ? (openai() ?? anthropic())
      : selected === "anthropic"
        ? (anthropic() ?? openai())
        : (openai() ?? anthropic());
  return (
    chosen ?? {
      ok: false,
      code: "planner_not_configured",
      message:
        "Configure a planner provider before generating a Gutenberg v2 candidate."
    }
  );
}

async function assertV2Enabled(
  siteId: SiteId
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site || site.activationStatus !== "active") {
    return {
      ok: false,
      code: "site_not_active",
      message: "Site must be active before Gutenberg v2 can be used."
    };
  }
  // v2 is the default content engine. The per-site desktop setting is
  // retired; the destination plugin's protocol flag is the only gate.
  if (protocolProbeForTests) {
    return (await protocolProbeForTests(site.baseUrl))
      ? { ok: true }
      : {
          ok: false,
          code: "gutenberg_v2_destination_disabled",
          message: "The destination has not enabled Gutenberg v2."
        };
  }
  try {
    const response = await fetchSiteUrl(
      `${site.baseUrl.replace(/\/+$/, "")}/wp-json/sitepilot/v1/protocol`,
      { signal: AbortSignal.timeout(15_000) }
    );
    const body = protocolSchema.safeParse(await response.json());
    if (!response.ok || !body.success || !body.data.v2.enabled) {
      return {
        ok: false,
        code: "gutenberg_v2_destination_disabled",
        message: "The destination has not enabled Gutenberg v2."
      };
    }
  } catch {
    return {
      ok: false,
      code: "gutenberg_v2_probe_failed",
      message: "Could not confirm that the destination enables Gutenberg v2."
    };
  }
  return { ok: true };
}

function readMapping(siteId: SiteId, requestId: RequestId): Mapping | null {
  const row = getDatabase()
    .connection.prepare<
      { siteId: string; requestId: string },
      {
        requestId: string;
        siteId: string;
        executionId: string;
        idempotencyKey: string;
        targetJson: string;
        decision: string | null;
        createdAt: string;
        updatedAt: string;
      }
    >(
      `SELECT request_id AS requestId, site_id AS siteId, execution_id AS executionId,
      idempotency_key AS idempotencyKey,
      target_json AS targetJson, decision, created_at AS createdAt, updated_at AS updatedAt
     FROM gutenberg_v2_request_executions WHERE site_id = @siteId AND request_id = @requestId`
    )
    .get({ siteId, requestId });
  if (!row) return null;
  let storedTarget: unknown;
  try {
    storedTarget = JSON.parse(row.targetJson);
  } catch {
    return null;
  }
  const target = targetSchema.safeParse(storedTarget);
  if (!target.success) return null;
  return {
    ...row,
    target: target.data,
    decision:
      row.decision === "approved" ||
      row.decision === "rejected" ||
      row.decision === "revision_requested"
        ? row.decision
        : null
  };
}

function saveMapping(mapping: Mapping): void {
  getDatabase()
    .connection.prepare(
      `INSERT INTO gutenberg_v2_request_executions
       (request_id, site_id, execution_id, idempotency_key, target_json, decision, created_at, updated_at)
     VALUES (@requestId, @siteId, @executionId, @idempotencyKey, @targetJson, @decision, @createdAt, @updatedAt)
     ON CONFLICT(request_id) DO UPDATE SET execution_id = excluded.execution_id,
       idempotency_key = excluded.idempotency_key, target_json = excluded.target_json,
       decision = excluded.decision, updated_at = excluded.updated_at`
    )
    .run({ ...mapping, targetJson: JSON.stringify(mapping.target) });
}

function claimV2Request(mapping: Mapping): boolean {
  const connection = getOptionalConnection();
  if (!connection) return false;
  const transaction = connection.transaction(() => {
    const claimed = connection
      .prepare(
        `UPDATE requests SET content_engine = 'gutenberg_v2', updated_at = @updatedAt
         WHERE id = @requestId AND site_id = @siteId AND content_engine IS NULL
           AND latest_plan_id IS NULL AND latest_execution_run_id IS NULL`
      )
      .run({
        siteId: mapping.siteId,
        requestId: mapping.requestId,
        updatedAt: mapping.updatedAt
      });
    if (claimed.changes !== 1) return false;
    const insertStatement = connection.prepare(
      `INSERT INTO gutenberg_v2_request_executions
         (request_id, site_id, execution_id, idempotency_key, target_json, decision, created_at, updated_at)
       VALUES (@requestId, @siteId, @executionId, @idempotencyKey, @targetJson, NULL, @createdAt, @updatedAt)`
    );
    const inserted = insertStatement.run({
      requestId: mapping.requestId,
      siteId: mapping.siteId,
      executionId: mapping.executionId,
      idempotencyKey: mapping.idempotencyKey,
      targetJson: JSON.stringify(mapping.target),
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt
    });
    if (inserted.changes !== 1) throw new Error("gutenberg_v2_claim_conflict");
    return true;
  });
  try {
    return transaction();
  } catch {
    return false;
  }
}

export function claimV1RequestEngine(
  siteId: SiteId,
  requestId: RequestId
): boolean {
  const connection = getOptionalConnection();
  // Lightweight planner-service test doubles do not model SQLite. Production
  // always supplies a connection, where this is the atomic ownership guard.
  if (!connection) return true;
  const result = connection
    .prepare(
      `UPDATE requests SET content_engine = 'v1', updated_at = @updatedAt
       WHERE id = @requestId AND site_id = @siteId AND content_engine IS NULL
         AND latest_plan_id IS NULL AND latest_execution_run_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM gutenberg_v2_request_executions v2
           WHERE v2.request_id = requests.id AND v2.site_id = requests.site_id
         )`
    )
    .run({ siteId, requestId, updatedAt: nowIso() });
  if (result.changes === 1) return true;
  const row = connection
    .prepare<
      { siteId: string; requestId: string },
      { contentEngine: string | null }
    >(`SELECT content_engine AS contentEngine FROM requests WHERE id = @requestId AND site_id = @siteId`)
    .get({ siteId, requestId });
  if (row?.contentEngine !== "v1") return false;
  return !hasGutenbergV2RequestMapping(siteId, requestId);
}

export function hasGutenbergV2RequestMapping(
  siteId: SiteId,
  requestId: RequestId
): boolean {
  const connection = getOptionalConnection();
  if (!connection) return false;
  const row = connection
    .prepare<{ siteId: string; requestId: string }, { requestId: string }>(
      `SELECT request_id AS requestId FROM gutenberg_v2_request_executions
       WHERE site_id = @siteId AND request_id = @requestId`
    )
    .get({ siteId, requestId });
  return row !== undefined;
}

function artifactReferences(candidate: GutenbergV2CompiledCandidate) {
  return [
    { id: "structure", kind: "structure_diff" as const },
    ...candidate.reviewArtifact.previewRefs.map((_, index) => ({
      id: `preview-${index}`,
      kind: "preview" as const,
      viewport: index === 0 ? ("desktop" as const) : ("mobile" as const)
    }))
  ];
}

function toState(mapping: Mapping, job: GutenbergV2JobRecord) {
  const candidate = job.candidate;
  return {
    requestId: mapping.requestId,
    siteId: mapping.siteId,
    executionId: mapping.executionId,
    target: mapping.target,
    state: mapping.decision === "rejected" ? ("rejected" as const) : job.state,
    ...(candidate
      ? {
          candidate: {
            candidateId: candidate.candidateId,
            planId: candidate.planId,
            operation: candidate.operation,
            contentHash: candidate.contentHash,
            intentHash: candidate.intentHash,
            capabilityFingerprint: candidate.capabilityFingerprint,
            ...(candidate.sourceState.revision
              ? { sourceRevision: candidate.sourceState.revision }
              : {}),
            requestedPostFields: Object.fromEntries(
              Object.entries(candidate.requestedPostFields).filter(
                ([field]) => field === "title" || field === "excerpt"
              )
            ),
            ...(candidate.requestedPostFields.featuredMediaRef === undefined
              ? {}
              : {
                  featuredImage: {
                    label:
                      candidate.intent.media.find(
                        (item) =>
                          item.ref ===
                          candidate.requestedPostFields.featuredMediaRef
                      )?.alt ?? candidate.requestedPostFields.featuredMediaRef
                  }
                }),
            validation: candidate.validation,
            reviewArtifacts: artifactReferences(candidate)
          }
        }
      : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.failure ? { failure: job.failure } : {}),
    createdAt: mapping.createdAt,
    updatedAt: mapping.updatedAt
  };
}

function mediaAttachments(
  attachments: ImageAttachmentPayload[] | undefined
): ImageAttachmentPayload[] {
  return (attachments ?? []).filter(
    (attachment) => attachment.purpose !== "reference"
  );
}

function referenceAttachments(
  attachments: ImageAttachmentPayload[] | undefined
): ImageAttachmentPayload[] {
  return (attachments ?? []).filter(
    (attachment) => attachment.purpose === "reference"
  );
}

function decodeAttachments(attachments: ImageAttachmentPayload[] | undefined) {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((attachment, index) => {
    const match =
      /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        attachment.dataUrl
      );
    if (!match)
      throw new GutenbergV2ServiceError(
        "schema_invalid",
        `Attachment ${index + 1} is not a supported raster data URL.`
      );
    // The decoded bytes are authoritative: they are checksummed when staged
    // and size-limited by the media policy. `sizeBytes` is display metadata
    // and may be an estimate for re-encoded uploads.
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.byteLength === 0) {
      throw new GutenbergV2ServiceError(
        "schema_invalid",
        `Attachment ${index + 1} is empty.`
      );
    }
    return {
      bytes,
      mediaType: match[1] as
        | "image/jpeg"
        | "image/png"
        | "image/webp"
        | "image/gif",
      ref: `attachment-${index + 1}`,
      alt: attachment.fileName.slice(0, 2_000)
    };
  });
}

async function requireMapping(
  siteId: SiteId,
  requestId: RequestId
): Promise<Mapping | { ok: false; code: string; message: string }> {
  const mapping = readMapping(siteId, requestId);
  if (!mapping) {
    return {
      ok: false,
      code: "gutenberg_v2_request_not_found",
      message: "No Gutenberg v2 execution exists for this request."
    };
  }
  return mapping;
}

async function saveRequestStatus(
  requestId: RequestId,
  siteId: SiteId,
  status:
    | "drafted"
    | "approved"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "partially_completed"
): Promise<void> {
  const request = await getDatabase().repositories.requests.getById(requestId);
  if (request && request.siteId === siteId) {
    await getDatabase().repositories.requests.save({
      ...request,
      status,
      updatedAt: nowIso()
    });
  }
}

/**
 * Explain a technical failure report in plain language with the site's
 * planning model. Only failures pay for this call; the deterministic
 * fallback keeps a readable message if the model is unavailable.
 */
async function explainForOperator(
  siteId: SiteId,
  technical: string,
  fallback: string
): Promise<string> {
  try {
    const planner = await choosePlanner(siteId);
    if (!planner.ok) return fallback;
    const result = await planner.client.complete(
      [{ role: "user", content: plainLanguagePrompt(technical) }],
      planner.model
    );
    return parsePlainLanguage(result.text) ?? fallback;
  } catch {
    return fallback;
  }
}

async function appendV2LifecycleMessage(
  siteId: SiteId,
  requestId: RequestId,
  text: string,
  technicalDetails?: string
): Promise<void> {
  const request = await getDatabase().repositories.requests.getById(requestId);
  if (!request || request.siteId !== siteId) return;
  const timestamp = nowIso();
  await getDatabase().repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId: request.threadId,
    siteId,
    requestId,
    author: { kind: "assistant" },
    body: {
      format: "plain_text",
      value: text,
      ...(technicalDetails === undefined || technicalDetails === text
        ? {}
        : { technicalDetails: technicalDetails.slice(0, 20_000) })
    },
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

async function appendV2Audit(
  siteId: SiteId,
  requestId: RequestId,
  eventType:
    | "approval_requested"
    | "approval_decided"
    | "execution_started"
    | "execution_completed"
    | "execution_failed",
  metadata: Record<string, unknown>
): Promise<void> {
  const timestamp = nowIso();
  await getDatabase().repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId,
    requestId,
    eventType,
    actor: DEFAULT_OPERATOR,
    metadata,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export async function continueGutenbergV2AfterFollowUp(input: {
  siteId: SiteId;
  requestId: RequestId;
  note: string;
  target?: GutenbergV2Target;
}) {
  const mapping = readMapping(input.siteId, input.requestId);
  const target = mapping?.target ?? input.target;
  if (!target) {
    return {
      ok: false as const,
      code: "gutenberg_v2_target_required",
      message: "A Gutenberg v2 operation target is required for this request."
    };
  }
  if (mapping) {
    const current = await getGutenbergV2RequestState({
      siteId: input.siteId,
      requestId: input.requestId
    });
    if (!current.ok) return current;
    const candidateId = current.state?.candidate?.candidateId;
    const state = current.state?.state;
    if (state !== undefined && WRITTEN_STATES.has(state)) {
      const postId = current.state?.result?.postId;
      return {
        ok: false as const,
        code: "execution_complete",
        message:
          postId !== undefined
            ? `This request already wrote post #${postId}. Start a new request for further changes.`
            : "This request already wrote to the destination. Start a new request for further changes."
      };
    }
    if (candidateId !== undefined && state === "review_ready") {
      const revision = await decideGutenbergV2Candidate({
        siteId: input.siteId,
        requestId: input.requestId,
        candidateId,
        decision: "revision_requested",
        note: input.note
      });
      if (!revision.ok) return revision;
    } else if (candidateId !== undefined && state === "approved") {
      const withdrawn = await withdrawGutenbergV2Approval({
        siteId: input.siteId,
        requestId: input.requestId,
        candidateId,
        note: input.note
      });
      if (!withdrawn.ok) return withdrawn;
    }
  }
  return generateGutenbergV2Candidate({
    siteId: input.siteId,
    requestId: input.requestId,
    target,
    // Only a follow-up on an existing candidate is a revision; a new request's
    // first message is already its prompt.
    ...(mapping ? { revisionNote: input.note } : {})
  });
}

async function withdrawGutenbergV2Approval(input: {
  siteId: SiteId;
  requestId: RequestId;
  candidateId: string;
  note: string;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const mapping = readMapping(input.siteId, input.requestId);
  if (!mapping) {
    return {
      ok: false,
      code: "gutenberg_v2_request_not_found",
      message: "No Gutenberg v2 execution exists for this request."
    };
  }
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) return runtime;
  try {
    await runtime.runtime.content.withdrawApproval({
      executionId: mapping.executionId,
      candidateId: input.candidateId
    });
    saveMapping({
      ...mapping,
      decision: "revision_requested",
      updatedAt: nowIso()
    });
    await appendV2Audit(input.siteId, input.requestId, "approval_decided", {
      engine: "gutenberg_v2",
      candidateId: input.candidateId,
      decision: "approval_withdrawn",
      note: input.note.trim().slice(0, 4_000)
    });
    await appendV2LifecycleMessage(
      input.siteId,
      input.requestId,
      friendlyDecision({
        decision: "withdrawn",
        target: mapping.target,
        note: input.note
      }),
      decisionReport({
        decision: "withdrawn",
        target: mapping.target,
        candidateId: input.candidateId,
        approverId: DEFAULT_OPERATOR.userProfileId,
        note: input.note
      })
    );
    return { ok: true };
  } catch (error) {
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
  }
}

export async function generateGutenbergV2Candidate(input: {
  siteId: SiteId;
  requestId: RequestId;
  target: GutenbergV2Target;
  /** The operator follow-up that superseded the previous candidate. */
  revisionNote?: string;
}) {
  const enabled = await assertV2Enabled(input.siteId);
  if (!enabled.ok) return enabled;
  const db = getDatabase();
  const request = await db.repositories.requests.getById(input.requestId);
  if (!request || request.siteId !== input.siteId)
    return {
      ok: false as const,
      code: "request_not_found",
      message: "Request not found for this site."
    };
  if (
    request.latestPlanId !== undefined ||
    request.latestExecutionRunId !== undefined
  ) {
    return {
      ok: false as const,
      code: "request_engine_conflict",
      message:
        "This request already belongs to the v1 planning engine; create a fresh request for Gutenberg v2."
    };
  }
  if (request.status === "clarifying")
    return {
      ok: false as const,
      code: "request_clarifying",
      message:
        "Resolve clarification before generating a Gutenberg v2 candidate."
    };
  const existing = readMapping(input.siteId, input.requestId);
  if (
    existing &&
    hashGutenbergV2Value(existing.target) !== hashGutenbergV2Value(input.target)
  ) {
    return {
      ok: false as const,
      code: "target_mismatch",
      message:
        "The request is already bound to a different Gutenberg v2 target."
    };
  }
  const generationKey = `${input.siteId}:${input.requestId}`;
  if (inFlightV2Generations.has(generationKey)) {
    return {
      ok: false as const,
      code: "generation_in_progress",
      message:
        "A Gutenberg v2 candidate is still being generated; retry its request state."
    };
  }
  let existingJob: GutenbergV2JobRecord | null = null;
  if (existing) {
    const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
    if (!runtime.ok) return runtime;
    try {
      existingJob = await runtime.runtime.journal.get(existing.executionId);
      const job = existingJob;
      if (job?.state === "review_ready" && existing.decision === null) {
        return { ok: true as const, state: toState(existing, job) };
      }
      if (job && WRITTEN_STATES.has(job.state)) {
        return {
          ok: false as const,
          code: "execution_complete",
          message:
            job.result?.postId !== undefined
              ? `This request already wrote post #${job.result.postId}. Start a new request for further changes.`
              : "This request already wrote to the destination. Start a new request for further changes."
        };
      }
      if (
        job &&
        ["approved", "preparing", "committing", "verifying"].includes(job.state)
      )
        return {
          ok: false as const,
          code: "execution_in_progress",
          message:
            "This Gutenberg v2 candidate is approved or being applied. Execute it before generating again."
        };
      if (job?.state === "compiling") {
        return {
          ok: false as const,
          code: "generation_in_progress",
          message:
            "A Gutenberg v2 candidate is still being generated; retry its request state."
        };
      }
    } finally {
      await runtime.runtime.close();
    }
  }
  if (
    !existing &&
    (request.status === "executing" ||
      request.status === "approved" ||
      request.status === "awaiting_approval")
  ) {
    return {
      ok: false as const,
      code: "request_in_progress",
      message: "The request already has an active v1 operation."
    };
  }
  if (inFlightV2Generations.has(generationKey)) {
    return {
      ok: false as const,
      code: "generation_in_progress",
      message:
        "A Gutenberg v2 candidate is still being generated; retry its request state."
    };
  }
  let mapping: Mapping = existing ?? {
    requestId: input.requestId,
    siteId: input.siteId,
    executionId: randomUUID(),
    idempotencyKey: randomUUID(),
    target: input.target,
    decision: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  if (!existing && !claimV2Request(mapping)) {
    const claimed = readMapping(input.siteId, input.requestId);
    return claimed
      ? {
          ok: false as const,
          code: "generation_in_progress",
          message:
            "A Gutenberg v2 candidate is still being generated; retry its request state."
        }
      : {
          ok: false as const,
          code: "request_engine_conflict",
          message: "Another content engine already owns this request."
        };
  }
  // A decided candidate, or a job that failed before writing, cannot resume
  // under the same execution identity; start a fresh one for the new attempt.
  if (
    existing &&
    (existing.decision !== null ||
      (existingJob !== null &&
        PRE_WRITE_TERMINAL_STATES.has(existingJob.state)))
  ) {
    mapping = {
      ...mapping,
      executionId: randomUUID(),
      idempotencyKey: randomUUID(),
      decision: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    saveMapping(mapping);
  }
  inFlightV2Generations.add(generationKey);
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) {
    inFlightV2Generations.delete(generationKey);
    return runtime;
  }
  try {
    const planner = await choosePlanner(input.siteId);
    if (!planner.ok) return planner;
    // Media attachments are staged and placed; reference attachments (PDF
    // pages, mock-ups) are only shown to the planner.
    const attachments = decodeAttachments(
      mediaAttachments(request.attachments)
    );
    const referenceImages = referenceAttachments(request.attachments).map(
      (attachment) => ({
        label: attachment.fileName,
        mediaType: attachment.mediaType,
        dataUrl: attachment.dataUrl
      })
    );
    const media = [];
    const stagedChecksums = new Set<string>();
    for (const attachment of attachments) {
      const staged = await runtime.runtime.stagedAssets.stage({
        bytes: attachment.bytes,
        mediaType: attachment.mediaType
      });
      // The same image attached twice (e.g. across retries) is one media item.
      if (stagedChecksums.has(staged.checksum)) continue;
      stagedChecksums.add(staged.checksum);
      media.push({
        ref: attachment.ref,
        source: {
          kind: "staged_asset" as const,
          stagedAssetId: staged.stagedAssetId,
          checksum: staged.checksum,
          mediaType: staged.mediaType,
          byteLength: staged.byteLength
        },
        alt: attachment.alt
      });
    }
    const postId =
      input.target.operation === "create_draft"
        ? undefined
        : input.target.postId;
    const capabilities = await runtime.runtime.content.discoverCapabilities({
      siteId: input.siteId,
      postType: input.target.postType,
      ...(postId === undefined ? {} : { postId })
    });
    const source =
      input.target.operation === "create_draft"
        ? undefined
        : await runtime.runtime.readSource({
            executionId: mapping.executionId,
            siteId: input.siteId,
            postType: input.target.postType,
            postId: input.target.postId
          });
    if (
      source &&
      (source.siteId !== input.siteId ||
        source.postType !== input.target.postType ||
        source.postId !==
          (input.target.operation === "create_draft"
            ? undefined
            : input.target.postId))
    ) {
      throw new GutenbergV2ServiceError(
        "runtime_changed",
        "The trusted source snapshot does not match the requested destination."
      );
    }
    const target =
      input.target.operation === "create_draft"
        ? {
            operation: "create_draft" as const,
            postType: input.target.postType
          }
        : {
            operation: input.target.operation,
            source: source!
          };
    // request.userPrompt already holds the merged follow-up; the previous
    // plan lets the model keep untouched content stable.
    const previousPlan =
      input.revisionNote === undefined
        ? undefined
        : previousPlanFrom(existingJob);
    const revision: GutenbergV2PlanRevision | undefined =
      input.revisionNote === undefined
        ? undefined
        : {
            instructions: [input.revisionNote],
            ...(previousPlan === undefined ? {} : { previousPlan })
          };
    const planned = await buildLlmGutenbergV2Plan({
      request: request.userPrompt,
      siteId: input.siteId,
      target,
      capabilities,
      ...(media.length > 0 ? { media } : {}),
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
      ...(revision === undefined ? {} : { revision }),
      client: planner.client,
      model: planner.model
    });
    const candidate = await runtime.runtime.content.compileCandidate({
      executionId: mapping.executionId,
      idempotencyKey: mapping.idempotencyKey,
      plan: planned.plan
    });
    const job = await runtime.runtime.journal.get(mapping.executionId);
    if (!job)
      throw new Error("The v2 execution journal did not retain the candidate.");
    await saveRequestStatus(input.requestId, input.siteId, "awaiting_approval");
    const notices = requestNotices({
      prompt: request.userPrompt,
      attachmentCount: mediaAttachments(request.attachments).length,
      referenceCount: referenceAttachments(request.attachments).length
    });
    await appendV2LifecycleMessage(
      input.siteId,
      input.requestId,
      friendlyCandidateReady({ target: input.target, candidate, notices }),
      candidateReadyReport({
        target: input.target,
        candidate,
        executionId: mapping.executionId,
        notices,
        ...(input.revisionNote === undefined
          ? {}
          : { revisionNote: input.revisionNote })
      })
    );
    await appendV2Audit(input.siteId, input.requestId, "approval_requested", {
      engine: "gutenberg_v2",
      operation: input.target.operation,
      candidateId: candidate.candidateId,
      planId: candidate.planId
    });
    return { ok: true as const, state: toState(mapping, job) };
  } catch (error) {
    const uncertain = await runtime.runtime.journal
      .get(mapping.executionId)
      .catch(() => null);
    if (uncertain && ["committing", "verifying"].includes(uncertain.state)) {
      return { ok: true as const, state: toState(mapping, uncertain) };
    }
    const reported = reportableError(error);
    await appendV2Audit(input.siteId, input.requestId, "execution_failed", {
      engine: "gutenberg_v2",
      executionId: mapping.executionId,
      phase: "generation",
      code: reported.code ?? "generation_failed",
      message: reported.message,
      issues: reported.issues ?? []
    }).catch(() => undefined);
    const failureNotices = requestNotices({
      prompt: request.userPrompt,
      attachmentCount: mediaAttachments(request.attachments).length,
      referenceCount: referenceAttachments(request.attachments).length,
      failed: true
    });
    const technical = failureReport({
      stage: "generation",
      target: input.target,
      executionId: mapping.executionId,
      error: reported,
      notices: failureNotices
    });
    await appendV2LifecycleMessage(
      input.siteId,
      input.requestId,
      await explainForOperator(
        input.siteId,
        technical,
        friendlyFailureFallback({
          stage: "generation",
          target: input.target,
          notices: failureNotices
        })
      ),
      technical
    ).catch(() => undefined);
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
    inFlightV2Generations.delete(generationKey);
  }
}

export async function decideGutenbergV2Candidate(input: {
  siteId: SiteId;
  requestId: RequestId;
  candidateId: string;
  decision: "approved" | "rejected" | "revision_requested";
  note?: string;
}) {
  const enabled = await assertV2Enabled(input.siteId);
  if (!enabled.ok) return enabled;
  const mapping = await requireMapping(input.siteId, input.requestId);
  if ("ok" in mapping) return mapping;
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) return runtime;
  try {
    const job = await runtime.runtime.journal.get(mapping.executionId);
    if (!job || job.candidate?.candidateId !== input.candidateId)
      return {
        ok: false as const,
        code: "candidate_not_found",
        message: "Candidate not found for this request."
      };
    let next: GutenbergV2JobRecord;
    if (input.decision === "approved") {
      if (job.state === "approved" && job.approval) {
        // The journal is authoritative if the process crashed after the
        // content transition but before the request mapping was saved.
        next = job;
      } else {
        const approvedAt = nowIso();
        next = await runtime.runtime.content.recordApproval({
          executionId: mapping.executionId,
          approval: {
            schemaVersion: "sitepilot.approval/v2",
            approvalId: randomUUID(),
            approverId: DEFAULT_OPERATOR.userProfileId,
            approvedAt,
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            binding: createGutenbergV2ApprovalBinding(job.candidate)
          }
        });
      }
      mapping.decision = "approved";
    } else {
      next = await runtime.runtime.content.rejectCandidate({
        executionId: mapping.executionId,
        candidateId: input.candidateId
      });
      mapping.decision = input.decision;
    }
    mapping.updatedAt = nowIso();
    saveMapping(mapping);
    await saveRequestStatus(
      input.requestId,
      input.siteId,
      input.decision === "approved" ? "approved" : "drafted"
    );
    await appendV2LifecycleMessage(
      input.siteId,
      input.requestId,
      friendlyDecision({
        decision: input.decision,
        target: mapping.target,
        ...(input.note === undefined ? {} : { note: input.note })
      }),
      decisionReport({
        decision: input.decision,
        target: mapping.target,
        candidateId: input.candidateId,
        approverId: DEFAULT_OPERATOR.userProfileId,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(next.approval?.expiresAt === undefined
          ? {}
          : { expiresAt: next.approval.expiresAt })
      })
    );
    await appendV2Audit(input.siteId, input.requestId, "approval_decided", {
      engine: "gutenberg_v2",
      candidateId: input.candidateId,
      decision: input.decision,
      ...(input.note === undefined
        ? {}
        : { note: input.note.trim().slice(0, 4_000) })
    });
    return { ok: true as const, state: toState(mapping, next) };
  } catch (error) {
    const uncertain = await runtime.runtime.journal
      .get(mapping.executionId)
      .catch(() => null);
    if (uncertain && ["committing", "verifying"].includes(uncertain.state)) {
      return { ok: true as const, state: toState(mapping, uncertain) };
    }
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
  }
}

export async function executeGutenbergV2Candidate(input: {
  siteId: SiteId;
  requestId: RequestId;
}) {
  const enabled = await assertV2Enabled(input.siteId);
  if (!enabled.ok) return enabled;
  const mapping = await requireMapping(input.siteId, input.requestId);
  if ("ok" in mapping) return mapping;
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) return runtime;
  try {
    await appendV2Audit(input.siteId, input.requestId, "execution_started", {
      engine: "gutenberg_v2",
      executionId: mapping.executionId
    });
    const result = await runtime.runtime.content.executeApprovedCandidate({
      executionId: mapping.executionId
    });
    mapping.updatedAt = nowIso();
    saveMapping(mapping);
    await saveRequestStatus(
      input.requestId,
      input.siteId,
      result.state === "succeeded"
        ? "completed"
        : result.state === "rolled_back"
          ? "partially_completed"
          : "failed"
    );
    const executionTechnical = executionReport({
      target: mapping.target,
      result,
      job: await runtime.runtime.journal
        .get(mapping.executionId)
        .catch(() => null)
    });
    const executionFriendly = friendlyExecution({
      target: mapping.target,
      result
    });
    await appendV2LifecycleMessage(
      input.siteId,
      input.requestId,
      result.state === "succeeded"
        ? executionFriendly
        : await explainForOperator(
            input.siteId,
            executionTechnical,
            executionFriendly
          ),
      executionTechnical
    );
    await appendV2Audit(
      input.siteId,
      input.requestId,
      result.state === "succeeded" ? "execution_completed" : "execution_failed",
      {
        engine: "gutenberg_v2",
        executionId: mapping.executionId,
        state: result.state,
        postId: result.postId
      }
    );
    const job = await runtime.runtime.journal.get(mapping.executionId);
    if (!job)
      throw new Error("The v2 execution journal did not retain the result.");
    return { ok: true as const, state: toState(mapping, job) };
  } catch (error) {
    const uncertain = await runtime.runtime.journal
      .get(mapping.executionId)
      .catch(() => null);
    if (uncertain && ["committing", "verifying"].includes(uncertain.state)) {
      return { ok: true as const, state: toState(mapping, uncertain) };
    }
    const reported = reportableError(error);
    await appendV2Audit(input.siteId, input.requestId, "execution_failed", {
      engine: "gutenberg_v2",
      executionId: mapping.executionId,
      code: reported.code ?? "execution_failed",
      message: reported.message,
      issues: reported.issues ?? []
    }).catch(() => undefined);
    const executionFailure = failureReport({
      stage: "execution",
      target: mapping.target,
      executionId: mapping.executionId,
      error: reported
    });
    await appendV2LifecycleMessage(
      input.siteId,
      input.requestId,
      await explainForOperator(
        input.siteId,
        executionFailure,
        friendlyFailureFallback({ stage: "execution", target: mapping.target })
      ),
      executionFailure
    ).catch(() => undefined);
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
  }
}

/**
 * The post most recently written by a v2 request in this thread, as an
 * update target. Follow-ups in a thread that already produced a post update
 * that post instead of drafting a new one.
 */
export async function findGutenbergV2WrittenPostTarget(input: {
  siteId: SiteId;
  requestIds: readonly RequestId[];
}): Promise<GutenbergV2Target | null> {
  for (const requestId of input.requestIds) {
    const mapping = readMapping(input.siteId, requestId);
    if (!mapping) continue;
    const current = await getGutenbergV2RequestState({
      siteId: input.siteId,
      requestId
    });
    if (!current.ok || !current.state) continue;
    const postId = current.state.result?.postId;
    if (current.state.state === "succeeded" && postId !== undefined) {
      return {
        operation: "apply_operations",
        postType: mapping.target.postType,
        postId
      };
    }
  }
  return null;
}

// Read-only inspection remains available after either feature gate is disabled
// so operators can reconcile outstanding work safely.
export async function getGutenbergV2RequestState(input: {
  siteId: SiteId;
  requestId: RequestId;
}) {
  const mapping = readMapping(input.siteId, input.requestId);
  if (!mapping) return { ok: true as const, state: null };
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) return runtime;
  try {
    const job = await runtime.runtime.journal.get(mapping.executionId);
    return { ok: true as const, state: job ? toState(mapping, job) : null };
  } catch (error) {
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
  }
}

export async function listGutenbergV2PendingCandidates(input: {
  siteId: SiteId;
}) {
  const rows = getDatabase()
    .connection.prepare<
      { siteId: string },
      {
        requestId: string;
        siteId: string;
        executionId: string;
        idempotencyKey: string;
        targetJson: string;
        decision: string | null;
        createdAt: string;
        updatedAt: string;
      }
    >(
      `SELECT request_id AS requestId, site_id AS siteId, execution_id AS executionId,
            idempotency_key AS idempotencyKey,
            target_json AS targetJson, decision, created_at AS createdAt, updated_at AS updatedAt
     FROM gutenberg_v2_request_executions WHERE site_id = @siteId ORDER BY updated_at DESC LIMIT 200`
    )
    .all({ siteId: input.siteId });
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) return runtime;
  try {
    const candidates = [];
    for (const row of rows) {
      const parsed = targetSchema.parse(
        JSON.parse((row as unknown as { targetJson: string }).targetJson)
      );
      const mapping: Mapping = {
        ...row,
        target: parsed,
        decision:
          row.decision === "approved" ||
          row.decision === "rejected" ||
          row.decision === "revision_requested"
            ? row.decision
            : null
      };
      const job = await runtime.runtime.journal.get(mapping.executionId);
      if (job && ["review_ready", "approved"].includes(job.state))
        candidates.push(toState(mapping, job));
    }
    return { ok: true as const, candidates };
  } catch (error) {
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
  }
}

export async function getGutenbergV2ReviewArtifact(input: {
  siteId: SiteId;
  requestId: RequestId;
  artifactId: string;
}) {
  const mapping = await requireMapping(input.siteId, input.requestId);
  if ("ok" in mapping) return mapping;
  const runtime = await createGutenbergV2DesktopRuntime(input.siteId);
  if (!runtime.ok) return runtime;
  try {
    const job = await runtime.runtime.journal.get(mapping.executionId);
    const candidate = job?.candidate;
    if (!candidate)
      return {
        ok: false as const,
        code: "candidate_not_found",
        message: "Candidate not found for this request."
      };
    const refs = artifactReferences(candidate);
    const ref =
      input.artifactId === "structure"
        ? candidate.reviewArtifact.structureDiffRef
        : candidate.reviewArtifact.previewRefs[
            Number(input.artifactId.replace("preview-", ""))
          ];
    const found =
      refs.some((entry) => entry.id === input.artifactId) &&
      typeof ref === "string";
    if (!found)
      return {
        ok: false as const,
        code: "artifact_not_found",
        message: "Review artifact not found."
      };
    const data = await runtime.runtime.readReviewArtifact(ref!);
    if (data.byteLength > 20 * 1024 * 1024)
      return {
        ok: false as const,
        code: "request_too_large",
        message: "Review artifact exceeds the 20 MB limit."
      };
    return {
      ok: true as const,
      artifact: {
        id: input.artifactId,
        kind:
          input.artifactId === "structure"
            ? ("structure_diff" as const)
            : ("preview" as const),
        mimeType:
          input.artifactId === "structure"
            ? ("application/json" as const)
            : ("image/png" as const),
        dataBase64: data.toString("base64")
      }
    };
  } catch (error) {
    return errorResult(error);
  } finally {
    await runtime.runtime.close();
  }
}
