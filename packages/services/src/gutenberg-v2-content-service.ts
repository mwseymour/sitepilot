import { randomUUID } from "node:crypto";

import {
  GUTENBERG_V2_SUPPORT_MATRIX,
  gutenbergV2ApprovalSchema,
  gutenbergV2BlockPlanSchema,
  gutenbergV2CommitReceiptSchema,
  gutenbergV2CompiledCandidateSchema,
  gutenbergV2EditorCapabilitySnapshotSchema,
  gutenbergV2JobRecordSchema,
  gutenbergV2PrepareCommitResponseSchema,
  gutenbergV2ReadbackSchema,
  gutenbergV2SourceSnapshotSchema,
  gutenbergV2ValidationFailureCodeSchema,
  gutenbergV2ValidationIssueSchema,
  gutenbergV2ValidationReportSchema,
  type GutenbergV2Approval,
  type GutenbergV2ApprovalBinding,
  type GutenbergV2BlockNode,
  type GutenbergV2BlockPlan,
  type GutenbergV2CommitReceipt,
  type GutenbergV2CompiledCandidate,
  type GutenbergV2EditorCapabilitySnapshot,
  type GutenbergV2ExecutionResult,
  type GutenbergV2ExecutionState,
  type GutenbergV2JobRecord,
  type GutenbergV2MediaMapping,
  type GutenbergV2PrepareCommitRequest,
  type GutenbergV2PrepareCommitResponse,
  type GutenbergV2PreparedCommit,
  type GutenbergV2Readback,
  type GutenbergV2RecoverResponse,
  type GutenbergV2SourceSnapshot,
  type GutenbergV2ValidationIssue,
  type GutenbergV2ValidationReport
} from "@sitepilot/contracts";

import {
  hashGutenbergV2Content,
  hashGutenbergV2Value
} from "./gutenberg-v2-hashing.js";
import type { GutenbergV2ExecutionJournal } from "./gutenberg-v2-journal.js";

export type GutenbergV2ReviewArtifact = {
  structureDiffRef: string;
  previewRefs: string[];
};

export type GutenbergV2WorkerCompileResult = {
  intent: GutenbergV2BlockPlan;
  serializedContent: string;
  contentHash: string;
  intentHash: string;
  capabilityFingerprint: string;
  validation: GutenbergV2ValidationReport;
  reviewArtifact: GutenbergV2ReviewArtifact;
};

export interface GutenbergV2Worker {
  discoverCapabilities(input: {
    siteId: string;
    postType: "post" | "page";
    postId?: number;
    expectedFingerprint?: string;
  }): Promise<GutenbergV2EditorCapabilitySnapshot>;
  compile(input: {
    candidateId: string;
    plan: GutenbergV2BlockPlan;
    capabilities: GutenbergV2EditorCapabilitySnapshot;
    source?: GutenbergV2SourceSnapshot;
    mediaMapping?: GutenbergV2MediaMapping[];
  }): Promise<GutenbergV2WorkerCompileResult>;
  validatePreparedContent(input: {
    candidate: GutenbergV2CompiledCandidate;
    serializedContent: string;
    expectedSerializedContent: string;
    capabilities: GutenbergV2EditorCapabilitySnapshot;
    mediaMapping: GutenbergV2MediaMapping[];
  }): Promise<GutenbergV2ValidationReport>;
  verifyPersistedContent(input: {
    candidate: GutenbergV2CompiledCandidate;
    readback: GutenbergV2Readback;
    capabilities: GutenbergV2EditorCapabilitySnapshot;
    preparedCommit: GutenbergV2PreparedCommit;
  }): Promise<GutenbergV2ValidationReport>;
}

export interface GutenbergV2WordPressTransport {
  readSource(input: {
    siteId: string;
    target: Extract<
      GutenbergV2BlockPlan,
      { operation: "replace_content" | "apply_operations" }
    >["target"];
  }): Promise<GutenbergV2SourceSnapshot>;
  prepareCommit(
    input: GutenbergV2PrepareCommitRequest
  ): Promise<GutenbergV2PrepareCommitResponse>;
  commitCandidate(input: {
    schemaVersion: "sitepilot.commit-request/v2";
    executionId: string;
    idempotencyKey: string;
    preparedCommitId: string;
  }): Promise<GutenbergV2CommitReceipt>;
  reconcileExecution(input: {
    schemaVersion: "sitepilot.reconcile-request/v2";
    siteId: string;
    executionId: string;
    idempotencyKey: string;
  }): Promise<GutenbergV2CommitReceipt | null>;
  readBack(input: {
    schemaVersion: "sitepilot.readback-request/v2";
    siteId: string;
    executionId: string;
    postId: number;
  }): Promise<GutenbergV2Readback>;
  conditionalRollback(input: {
    schemaVersion: "sitepilot.recover-request/v2";
    siteId: string;
    executionId: string;
    postId: number;
    beforeStateRef: string;
    expectedWrittenContentHash: string;
    expectedWrittenRevision: string;
    expectedWrittenFieldsHash: string;
  }): Promise<GutenbergV2RecoverResponse>;
}

export interface GutenbergV2ApprovalStore {
  get(approvalId: string): Promise<GutenbergV2Approval | null>;
  save(approval: GutenbergV2Approval): Promise<void>;
}

export class InMemoryGutenbergV2ApprovalStore implements GutenbergV2ApprovalStore {
  readonly #approvals = new Map<string, GutenbergV2Approval>();

  public async get(approvalId: string): Promise<GutenbergV2Approval | null> {
    return this.#approvals.get(approvalId) ?? null;
  }

  public async save(approval: GutenbergV2Approval): Promise<void> {
    const parsed = gutenbergV2ApprovalSchema.parse(approval);
    const existing = this.#approvals.get(parsed.approvalId);
    if (
      existing &&
      hashGutenbergV2Value(existing) !== hashGutenbergV2Value(parsed)
    ) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        "An approval ID cannot be rebound to another candidate."
      );
    }
    this.#approvals.set(parsed.approvalId, parsed);
  }
}

export interface GutenbergV2MediaService {
  resolveForCommit(input: {
    executionId: string;
    idempotencyKey: string;
    candidate: GutenbergV2CompiledCandidate;
    approval: GutenbergV2Approval;
  }): Promise<{
    mapping: GutenbergV2MediaMapping[];
    createdMediaIds: number[];
  }>;
}

export type GutenbergV2ContentServiceDependencies = {
  worker: GutenbergV2Worker;
  wordpress: GutenbergV2WordPressTransport;
  journal: GutenbergV2ExecutionJournal;
  approvals: GutenbergV2ApprovalStore;
  media: GutenbergV2MediaService;
  clock?: { now(): Date };
  ids?: { next(): string };
};

export class GutenbergV2ServiceError extends Error {
  public readonly code: GutenbergV2ValidationIssue["code"];
  public readonly retryable: boolean;
  public readonly issues: readonly GutenbergV2ValidationIssue[];

  public constructor(
    code: GutenbergV2ValidationIssue["code"],
    message: string,
    options?: {
      retryable?: boolean;
      cause?: unknown;
      issues?: readonly GutenbergV2ValidationIssue[];
    }
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "GutenbergV2ServiceError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.issues = options?.issues ?? [];
  }
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<GutenbergV2ExecutionState, readonly GutenbergV2ExecutionState[]>
> = {
  planned: ["compiling", "pre_write_failed"],
  compiling: ["review_ready", "pre_write_failed"],
  review_ready: ["approved", "rejected", "stale_approval"],
  approved: ["preparing", "stale_approval", "pre_write_failed"],
  preparing: ["committing", "stale_approval", "pre_write_failed"],
  committing: ["verifying", "stale_approval"],
  verifying: [
    "succeeded",
    "post_write_verification_failed",
    "rolled_back",
    "rollback_conflict",
    "manual_intervention_required"
  ],
  succeeded: [],
  rejected: [],
  stale_approval: [],
  pre_write_failed: [],
  post_write_verification_failed: [],
  rolled_back: [],
  rollback_conflict: [],
  manual_intervention_required: []
};

const staticSupport = new Map(
  GUTENBERG_V2_SUPPORT_MATRIX.map((entry) => [entry.name, entry])
);

function planPostType(plan: GutenbergV2BlockPlan): "post" | "page" {
  return plan.target.postType;
}

function planPostId(plan: GutenbergV2BlockPlan): number | undefined {
  return plan.operation === "create_draft" ? undefined : plan.target.postId;
}

function planBlocks(plan: GutenbergV2BlockPlan): GutenbergV2BlockNode[] {
  if (plan.operation !== "apply_operations") return plan.blocks;
  const result: GutenbergV2BlockNode[] = [];
  for (const operation of plan.operations) {
    if (operation.type === "insert_blocks") result.push(...operation.blocks);
    if (operation.type === "edit_block") result.push(operation.replacement);
  }
  return result;
}

function walkBlocks(blocks: GutenbergV2BlockNode[]): GutenbergV2BlockNode[] {
  const result: GutenbergV2BlockNode[] = [];
  const pending = [...blocks];
  while (pending.length > 0) {
    const block = pending.shift()!;
    result.push(block);
    pending.unshift(...block.children);
  }
  return result;
}

function requestedPostFields(
  plan: GutenbergV2BlockPlan
): Record<string, string> {
  if (!("postFields" in plan) || plan.postFields === undefined) return {};
  return Object.fromEntries(
    Object.entries(plan.postFields).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function approvalBinding(
  candidate: GutenbergV2CompiledCandidate
): GutenbergV2ApprovalBinding {
  const source =
    candidate.intent.operation === "create_draft"
      ? undefined
      : candidate.intent.target;
  return {
    candidateId: candidate.candidateId,
    siteId: candidate.siteId,
    operation: candidate.operation,
    intentHash: candidate.intentHash,
    contentHash: candidate.contentHash,
    requestedFieldsHash: candidate.requestedFieldsHash,
    affectedFieldsHash: candidate.sourceState.affectedFieldsHash,
    ...(source
      ? {
          sourceContentHash: source.sourceContentHash,
          sourceRevision: source.sourceRevision
        }
      : {}),
    capabilityFingerprint: candidate.capabilityFingerprint,
    mediaManifestHash: candidate.mediaManifestHash
  };
}

export function createGutenbergV2ApprovalBinding(
  candidate: GutenbergV2CompiledCandidate
): GutenbergV2ApprovalBinding {
  return approvalBinding(gutenbergV2CompiledCandidateSchema.parse(candidate));
}

function issue(
  code: GutenbergV2ValidationIssue["code"],
  phase: GutenbergV2ValidationIssue["phase"],
  message: string
): GutenbergV2ValidationIssue {
  return { code, phase, severity: "error", message };
}

export class GutenbergV2ContentService {
  readonly #dependencies: GutenbergV2ContentServiceDependencies;

  public constructor(dependencies: GutenbergV2ContentServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async discoverCapabilities(input: {
    siteId: string;
    postType: "post" | "page";
    postId?: number;
    expectedFingerprint?: string;
  }): Promise<GutenbergV2EditorCapabilitySnapshot> {
    const snapshot = gutenbergV2EditorCapabilitySnapshotSchema.parse(
      await this.#dependencies.worker.discoverCapabilities(input)
    );
    if (
      snapshot.siteId !== input.siteId ||
      snapshot.context.postType !== input.postType
    ) {
      throw new GutenbergV2ServiceError(
        "runtime_changed",
        "The editor capability context does not match the requested destination."
      );
    }
    if (
      input.expectedFingerprint &&
      snapshot.fingerprint !== input.expectedFingerprint
    ) {
      throw new GutenbergV2ServiceError(
        "runtime_changed",
        "The editor capability fingerprint changed."
      );
    }
    return snapshot;
  }

  /** Read the trusted editor source through the configured WordPress transport. */
  public async readSource(input: {
    executionId?: string;
    siteId: string;
    postType: "post" | "page";
    postId: number;
  }): Promise<GutenbergV2SourceSnapshot> {
    const source = gutenbergV2SourceSnapshotSchema.parse(
      await this.#dependencies.wordpress.readSource({
        siteId: input.siteId,
        target: {
          postId: input.postId,
          postType: input.postType,
          sourceRevision: "unbound",
          sourceContentHash: "0".repeat(64),
          expectedFields: {}
        }
      })
    );
    if (
      source.siteId !== input.siteId ||
      source.postId !== input.postId ||
      source.postType !== input.postType
    ) {
      throw new GutenbergV2ServiceError(
        "runtime_changed",
        "The source snapshot does not match the requested destination."
      );
    }
    return source;
  }

  public async compileCandidate(input: {
    executionId: string;
    idempotencyKey: string;
    plan: GutenbergV2BlockPlan;
  }): Promise<GutenbergV2CompiledCandidate> {
    const plan = gutenbergV2BlockPlanSchema.parse(input.plan);
    const now = this.#now();
    const planHash = hashGutenbergV2Value(plan);
    const initial = gutenbergV2JobRecordSchema.parse({
      schemaVersion: "sitepilot.execution-journal/v2",
      executionId: input.executionId,
      idempotencyKey: input.idempotencyKey,
      siteId: plan.siteId,
      planHash,
      state: "planned",
      revision: 0,
      createdAt: now,
      updatedAt: now
    });
    const created = await this.#dependencies.journal.create(initial);
    let compiling: GutenbergV2JobRecord;
    if (!created.created) {
      this.#assertJobIdentity(
        created.record,
        input.executionId,
        input.idempotencyKey,
        plan.siteId,
        planHash
      );
      if (created.record.candidate) return created.record.candidate;
      if (
        created.record.state !== "planned" &&
        created.record.state !== "compiling"
      ) {
        throw new GutenbergV2ServiceError(
          "idempotency_conflict",
          `Execution ${input.executionId} cannot resume compilation from ${created.record.state}.`
        );
      }
      compiling =
        created.record.state === "planned"
          ? await this.#transition(created.record, "compiling")
          : created.record;
    } else {
      compiling = await this.#transition(created.record, "compiling");
    }
    try {
      const postId = planPostId(plan);
      const capabilities = await this.discoverCapabilities({
        siteId: plan.siteId,
        postType: planPostType(plan),
        ...(postId === undefined ? {} : { postId })
      });
      this.#assertSupportedPlan(plan, capabilities);
      const source =
        plan.operation === "create_draft"
          ? undefined
          : await this.#readAndCheckSource(plan);
      const candidateId = this.#id();
      const compiled = await this.#dependencies.worker.compile({
        candidateId,
        plan,
        capabilities,
        ...(source ? { source } : {})
      });
      const intent = gutenbergV2BlockPlanSchema.parse(compiled.intent);
      this.#assertSupportedPlan(intent, capabilities);
      const computedIntentHash = hashGutenbergV2Value(intent);
      const computedContentHash = hashGutenbergV2Content(
        compiled.serializedContent
      );
      if (
        compiled.intentHash !== computedIntentHash ||
        compiled.contentHash !== computedContentHash ||
        compiled.capabilityFingerprint !== capabilities.fingerprint ||
        compiled.validation.contentPreservation.intentHash !==
          computedIntentHash
      ) {
        throw new GutenbergV2ServiceError(
          "content_changed",
          "The compiler hashes do not match the returned v2 candidate."
        );
      }
      const validation = gutenbergV2ValidationReportSchema.parse(
        compiled.validation
      );
      if (validation.outcome !== "valid") {
        throw new GutenbergV2ServiceError(
          "invalid_block_markup",
          "The compiler rejected the v2 candidate."
        );
      }
      const fields = requestedPostFields(intent);
      const mediaManifest = intent.media.map((media) => ({
        ref: media.ref,
        approvedChecksum: media.source.checksum,
        alt: media.alt,
        ...(media.caption === undefined ? {} : { caption: media.caption })
      }));
      const sourceState = source
        ? {
            postId: source.postId,
            revision: source.revision,
            contentHash: source.contentHash,
            affectedFieldsHash: hashGutenbergV2Value(source.fields)
          }
        : { affectedFieldsHash: hashGutenbergV2Value({}) };
      const candidate = gutenbergV2CompiledCandidateSchema.parse({
        schemaVersion: "sitepilot.compiled-candidate/v2",
        candidateId,
        planId: intent.planId,
        siteId: intent.siteId,
        operation: intent.operation,
        intent,
        requestedPostFields: fields,
        serializedContent: compiled.serializedContent,
        contentHash: computedContentHash,
        intentHash: computedIntentHash,
        requestedFieldsHash: hashGutenbergV2Value(fields),
        sourceState,
        capabilityFingerprint: capabilities.fingerprint,
        mediaManifest,
        mediaManifestHash: hashGutenbergV2Value(mediaManifest),
        validation,
        reviewArtifact: compiled.reviewArtifact,
        compiledAt: this.#now()
      });
      await this.#transition(compiling, "review_ready", {
        candidateId,
        candidate
      });
      return candidate;
    } catch (error) {
      const serviceError = this.#normalizeServiceError(error);
      await this.#failBeforeWrite(compiling, serviceError, "compile");
      throw serviceError;
    }
  }

  public async recordApproval(input: {
    executionId: string;
    approval: GutenbergV2Approval;
  }): Promise<GutenbergV2JobRecord> {
    const job = await this.#requireJob(input.executionId);
    if (
      job.state === "approved" &&
      job.approval?.approvalId === input.approval.approvalId
    )
      return job;
    if (job.state !== "review_ready" || !job.candidate) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        `Execution ${input.executionId} is not ready for approval.`
      );
    }
    const approval = gutenbergV2ApprovalSchema.parse(input.approval);
    if (Date.parse(approval.expiresAt) <= Date.parse(this.#now())) {
      await this.#transition(job, "stale_approval", {
        failure: issue(
          "approval_expired",
          "prepare",
          "The approval expired before it was recorded."
        )
      });
      throw new GutenbergV2ServiceError(
        "approval_expired",
        "The approval has expired."
      );
    }
    if (
      hashGutenbergV2Value(approval.binding) !==
      hashGutenbergV2Value(approvalBinding(job.candidate))
    ) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        "The approval is not bound to this exact candidate and source state."
      );
    }
    await this.#dependencies.approvals.save(approval);
    return this.#transition(job, "approved", {
      approvalId: approval.approvalId,
      approval
    });
  }

  public async rejectCandidate(input: {
    executionId: string;
    candidateId: string;
  }): Promise<GutenbergV2JobRecord> {
    const job = await this.#requireJob(input.executionId);
    if (job.candidate?.candidateId !== input.candidateId) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        "The decision is not bound to the current candidate."
      );
    }
    if (job.state === "rejected") return job;
    if (job.state !== "review_ready") {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        `Execution ${input.executionId} is not ready for a review decision.`
      );
    }
    return this.#transition(job, "rejected", {
      failure: issue(
        "approval_invalid",
        "compile",
        "The candidate was rejected during review."
      )
    });
  }

  /**
   * Withdraw an approval that has not started execution, e.g. because the
   * operator asked for a change. The job becomes stale; nothing was written.
   */
  public async withdrawApproval(input: {
    executionId: string;
    candidateId: string;
  }): Promise<GutenbergV2JobRecord> {
    const job = await this.#requireJob(input.executionId);
    if (job.candidate?.candidateId !== input.candidateId) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        "The withdrawal is not bound to the current candidate."
      );
    }
    if (job.state === "stale_approval") return job;
    if (job.state !== "approved") {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        `Execution ${input.executionId} has no approval that can be withdrawn.`
      );
    }
    return this.#transition(job, "stale_approval", {
      failure: issue(
        "approval_invalid",
        "commit",
        "The approval was withdrawn before execution."
      )
    });
  }

  public async prepareCommit(input: {
    executionId: string;
  }): Promise<GutenbergV2PrepareCommitResponse> {
    let job = await this.#requireJob(input.executionId);
    if (job.state === "preparing" && job.preparedCommit && job.beforeStateRef) {
      return {
        schemaVersion: "sitepilot.prepare-commit-response/v2",
        preparedCommit: job.preparedCommit,
        beforeStateRef: job.beforeStateRef
      };
    }
    if (
      !["approved", "preparing"].includes(job.state) ||
      !job.candidate ||
      !job.approval
    ) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        `Execution ${input.executionId} is not approved for preparation.`
      );
    }
    if (job.state === "approved")
      job = await this.#transition(job, "preparing");
    try {
      const candidate = job.candidate!;
      const approval = await this.#requireCurrentApproval(job.approval!);
      const postId = planPostId(candidate.intent);
      const capabilities = await this.discoverCapabilities({
        siteId: candidate.siteId,
        postType: planPostType(candidate.intent),
        ...(postId === undefined ? {} : { postId }),
        expectedFingerprint: candidate.capabilityFingerprint
      });
      const source =
        candidate.intent.operation === "create_draft"
          ? undefined
          : await this.#readAndCheckSource(candidate.intent);
      const media = await this.#dependencies.media.resolveForCommit({
        executionId: job.executionId,
        idempotencyKey: job.idempotencyKey,
        candidate,
        approval
      });
      this.#assertMediaMapping(candidate, media.mapping);
      job = await this.#replaceWithinState(job, {
        createdMediaIds: media.createdMediaIds
      });
      const finalCompile = await this.#dependencies.worker.compile({
        candidateId: candidate.candidateId,
        plan: candidate.intent,
        capabilities,
        mediaMapping: media.mapping,
        ...(source === undefined ? {} : { source })
      });
      if (
        finalCompile.intentHash !== candidate.intentHash ||
        finalCompile.contentHash !==
          hashGutenbergV2Content(finalCompile.serializedContent) ||
        finalCompile.capabilityFingerprint !==
          candidate.capabilityFingerprint ||
        gutenbergV2ValidationReportSchema.parse(finalCompile.validation)
          .outcome !== "valid"
      ) {
        throw new GutenbergV2ServiceError(
          "media_changed",
          "Media binding changed content intent or invalidated the candidate."
        );
      }
      const request: GutenbergV2PrepareCommitRequest = {
        schemaVersion: "sitepilot.prepare-commit-request/v2",
        executionId: job.executionId,
        idempotencyKey: job.idempotencyKey,
        candidate,
        approval,
        mediaMapping: media.mapping,
        finalSerializedContent: finalCompile.serializedContent,
        finalContentHash: hashGutenbergV2Content(finalCompile.serializedContent)
      };
      const response = gutenbergV2PrepareCommitResponseSchema.parse(
        await this.#dependencies.wordpress.prepareCommit(request)
      );
      this.#assertPreparedCommit(job, response, request);
      const preparedValidation = gutenbergV2ValidationReportSchema.parse(
        await this.#dependencies.worker.validatePreparedContent({
          candidate,
          serializedContent: response.preparedCommit.finalContent,
          expectedSerializedContent: finalCompile.serializedContent,
          capabilities,
          mediaMapping: media.mapping
        })
      );
      if (preparedValidation.outcome !== "valid") {
        throw new GutenbergV2ServiceError(
          "content_changed",
          "WordPress sanitization changed the approved content intent."
        );
      }
      await this.#replaceWithinState(job, {
        preparedCommitId: response.preparedCommit.preparedCommitId,
        preparedCommit: response.preparedCommit,
        beforeStateRef: response.beforeStateRef,
        createdMediaIds: media.createdMediaIds
      });
      return response;
    } catch (error) {
      const serviceError = this.#normalizeServiceError(error);
      const current = await this.#requireJob(input.executionId);
      if (current.state === "preparing") {
        if (serviceError.retryable) {
          await this.#replaceWithinState(current, {
            failure: issue(
              serviceError.code,
              "prepare",
              `${serviceError.message} Retry will reconcile media and preparation with the same execution and idempotency identifiers.`
            )
          });
        } else {
          await this.#failBeforeWrite(current, serviceError, "prepare");
        }
      }
      throw serviceError;
    }
  }

  public async commitCandidate(input: {
    executionId: string;
  }): Promise<GutenbergV2CommitReceipt> {
    let job = await this.#requireJob(input.executionId);
    if (job.state === "preparing") {
      if (!job.preparedCommit || !job.approval) {
        throw new GutenbergV2ServiceError(
          "conditional_commit_failed",
          `Execution ${input.executionId} has no prepared commit.`
        );
      }
      try {
        await this.#requireCurrentApproval(job.approval);
      } catch (error) {
        if (
          error instanceof GutenbergV2ServiceError &&
          error.code === "approval_expired"
        ) {
          await this.#transition(job, "stale_approval", {
            failure: issue("approval_expired", "commit", error.message)
          });
        }
        throw error;
      }
      if (Date.parse(job.preparedCommit.expiresAt) <= Date.parse(this.#now())) {
        await this.#transition(job, "stale_approval", {
          failure: issue(
            "approval_expired",
            "commit",
            "The prepared commit expired before dispatch."
          )
        });
        throw new GutenbergV2ServiceError(
          "approval_expired",
          "The prepared commit has expired."
        );
      }
      try {
        await this.discoverCapabilities({
          siteId: job.siteId,
          postType: planPostType(job.candidate!.intent),
          ...(job.preparedCommit.postId === undefined
            ? {}
            : { postId: job.preparedCommit.postId }),
          expectedFingerprint: job.preparedCommit.capabilityFingerprint
        });
      } catch (error) {
        if (
          error instanceof GutenbergV2ServiceError &&
          error.code === "runtime_changed"
        ) {
          await this.#transition(job, "stale_approval", {
            failure: issue("runtime_changed", "commit", error.message)
          });
        }
        throw error;
      }
      job = await this.#transition(job, "committing");
    }
    if (
      job.state !== "committing" ||
      !job.preparedCommit ||
      !job.beforeStateRef
    ) {
      throw new GutenbergV2ServiceError(
        "conditional_commit_failed",
        `Execution ${input.executionId} has no prepared commit.`
      );
    }
    try {
      let receipt = await this.#dependencies.wordpress.reconcileExecution({
        schemaVersion: "sitepilot.reconcile-request/v2",
        siteId: job.siteId,
        executionId: job.executionId,
        idempotencyKey: job.idempotencyKey
      });
      if (!receipt) {
        await this.#requireCurrentApproval(job.approval!);
        if (
          Date.parse(job.preparedCommit.expiresAt) <= Date.parse(this.#now())
        ) {
          await this.#transition(job, "stale_approval", {
            failure: issue(
              "approval_expired",
              "commit",
              "The prepared commit expired before a retry could dispatch it."
            )
          });
          throw new GutenbergV2ServiceError(
            "approval_expired",
            "The prepared commit has expired."
          );
        }
        await this.discoverCapabilities({
          siteId: job.siteId,
          postType: planPostType(job.candidate!.intent),
          ...(job.preparedCommit.postId === undefined
            ? {}
            : { postId: job.preparedCommit.postId }),
          expectedFingerprint: job.preparedCommit.capabilityFingerprint
        });
        receipt = await this.#dependencies.wordpress.commitCandidate({
          schemaVersion: "sitepilot.commit-request/v2",
          executionId: job.executionId,
          idempotencyKey: job.idempotencyKey,
          preparedCommitId: job.preparedCommit.preparedCommitId
        });
      }
      const parsed = gutenbergV2CommitReceiptSchema.parse(receipt);
      this.#assertCommitReceipt(job, parsed);
      await this.#transition(job, "verifying", {
        postId: parsed.postId,
        beforeStateRef: parsed.beforeStateRef,
        writtenContentHash: parsed.persistedContentHash,
        persistedRevision: parsed.persistedRevision,
        persistedFieldsHash: parsed.persistedFieldsHash
      });
      return parsed;
    } catch (error) {
      if (
        error instanceof GutenbergV2ServiceError &&
        error.code === "approval_expired"
      )
        throw error;
      throw new GutenbergV2ServiceError(
        "conditional_commit_failed",
        "The commit outcome is uncertain; retry will reconcile by execution and idempotency ID before any further write.",
        { retryable: true, cause: error }
      );
    }
  }

  public async verifyPersistedContent(input: {
    executionId: string;
    receipt?: GutenbergV2CommitReceipt;
  }): Promise<GutenbergV2ExecutionResult> {
    const job = await this.#requireJob(input.executionId);
    if (job.result) return job.result;
    if (
      job.state !== "verifying" ||
      !job.candidate ||
      !job.postId ||
      !job.writtenContentHash ||
      !job.beforeStateRef
    ) {
      throw new GutenbergV2ServiceError(
        "verification_failed",
        `Execution ${input.executionId} is not ready for verification.`
      );
    }
    if (input.receipt)
      this.#assertCommitReceipt(
        job,
        gutenbergV2CommitReceiptSchema.parse(input.receipt)
      );
    let capabilities: GutenbergV2EditorCapabilitySnapshot;
    let readback: GutenbergV2Readback;
    try {
      capabilities = await this.discoverCapabilities({
        siteId: job.siteId,
        postType: planPostType(job.candidate.intent),
        postId: job.postId,
        expectedFingerprint: job.candidate.capabilityFingerprint
      });
      readback = gutenbergV2ReadbackSchema.parse(
        await this.#dependencies.wordpress.readBack({
          schemaVersion: "sitepilot.readback-request/v2",
          siteId: job.siteId,
          executionId: job.executionId,
          postId: job.postId
        })
      );
      if (
        readback.siteId !== job.siteId ||
        readback.executionId !== job.executionId ||
        readback.postId !== job.postId
      ) {
        throw new GutenbergV2ServiceError(
          "verification_failed",
          "WordPress returned readback for a different execution target."
        );
      }
      if (readback.postType !== planPostType(job.candidate.intent)) {
        throw new GutenbergV2ServiceError(
          "verification_failed",
          "WordPress returned readback for a different post type."
        );
      }
    } catch (error) {
      throw new GutenbergV2ServiceError(
        "verification_failed",
        "Persisted readback could not complete; the write is recorded and the execution remains retryable in verifying state.",
        { retryable: true, cause: error }
      );
    }

    let report: GutenbergV2ValidationReport;
    try {
      report = gutenbergV2ValidationReportSchema.parse(
        await this.#dependencies.worker.verifyPersistedContent({
          candidate: job.candidate,
          readback,
          capabilities,
          preparedCommit: job.preparedCommit!
        })
      );
    } catch (error) {
      const serviceError = this.#normalizeServiceError(error);
      if (serviceError.retryable) {
        throw new GutenbergV2ServiceError(
          "verification_failed",
          "Persisted verification could not complete; the write is recorded and the execution remains retryable in verifying state.",
          {
            retryable: true,
            cause: error,
            issues: serviceError.issues
          }
        );
      }
      report = this.#deterministicVerificationFailureReport(
        job.candidate.validation,
        job.candidate.requestedPostFields,
        readback,
        serviceError
      );
    }
    const hashesMatch =
      hashGutenbergV2Content(readback.rawContent) === readback.contentHash &&
      hashGutenbergV2Value(readback.fields) === readback.fieldsHash &&
      readback.contentHash === job.writtenContentHash &&
      readback.contentHash === job.preparedCommit?.serverPreparedContentHash &&
      readback.fieldsHash === job.persistedFieldsHash &&
      readback.fieldsHash === job.preparedCommit?.serverPreparedFieldsHash &&
      report.contentPreservation.checked.includes("post_fields");
    if (report.outcome === "valid" && hashesMatch) {
      const result = this.#executionResult(
        job,
        "succeeded",
        report,
        {
          attempted: false,
          outcome: "not_required"
        },
        readback
      );
      await this.#transition(job, "succeeded", { result });
      return result;
    }

    if (job.candidate.operation === "create_draft") {
      const failedReport = this.#failedVerificationReport(
        report,
        "The persisted content or post fields differ from the server-prepared candidate."
      );
      const result = this.#executionResult(
        job,
        "post_write_verification_failed",
        failedReport,
        {
          attempted: false,
          outcome: "not_required"
        },
        readback
      );
      await this.#transition(job, "post_write_verification_failed", {
        result,
        failure: issue(
          "persisted_content_invalid",
          "verify",
          "The created draft failed persisted editor verification and was retained for inspection."
        )
      });
      return result;
    }

    const recovery = await this.#dependencies.wordpress.conditionalRollback({
      schemaVersion: "sitepilot.recover-request/v2",
      siteId: job.siteId,
      executionId: job.executionId,
      postId: job.postId,
      beforeStateRef: job.beforeStateRef,
      expectedWrittenContentHash: job.writtenContentHash,
      expectedWrittenRevision: job.persistedRevision!,
      expectedWrittenFieldsHash: job.persistedFieldsHash!
    });
    const rollback = {
      attempted: true as const,
      outcome:
        recovery.outcome === "restored"
          ? ("succeeded" as const)
          : recovery.outcome,
      ...(recovery.evidenceRef ? { evidenceRef: recovery.evidenceRef } : {})
    };
    const nextState: GutenbergV2ExecutionState =
      recovery.outcome === "restored"
        ? "rolled_back"
        : recovery.outcome === "conflict"
          ? "rollback_conflict"
          : "manual_intervention_required";
    const failedReport = this.#failedVerificationReport(
      report,
      "The persisted content or post fields differ from the server-prepared candidate."
    );
    const result = this.#executionResult(
      job,
      nextState,
      failedReport,
      rollback,
      readback
    );
    await this.#transition(job, nextState, {
      result,
      failure: issue(
        recovery.outcome === "conflict"
          ? "rollback_conflict"
          : "persisted_content_invalid",
        "rollback",
        recovery.outcome === "restored"
          ? "Persisted verification failed and the prior content was restored."
          : "Persisted verification failed and automatic rollback could not safely restore the prior content."
      )
    });
    return result;
  }

  public async executeApprovedCandidate(input: {
    executionId: string;
  }): Promise<GutenbergV2ExecutionResult> {
    const job = await this.#requireJob(input.executionId);
    if (job.result) return job.result;
    if (["approved", "preparing"].includes(job.state))
      await this.prepareCommit(input);
    const refreshed = await this.#requireJob(input.executionId);
    const receipt = ["preparing", "committing"].includes(refreshed.state)
      ? await this.commitCandidate(input)
      : undefined;
    const afterCommit = await this.#requireJob(input.executionId);
    if (afterCommit.state === "verifying") {
      return this.verifyPersistedContent(
        receipt ? { ...input, receipt } : input
      );
    }
    if (afterCommit.result) return afterCommit.result;
    throw new GutenbergV2ServiceError(
      "idempotency_conflict",
      `Execution ${input.executionId} cannot execute from ${afterCommit.state}.`
    );
  }

  async #readAndCheckSource(
    plan: Extract<
      GutenbergV2BlockPlan,
      { operation: "replace_content" | "apply_operations" }
    >
  ): Promise<GutenbergV2SourceSnapshot> {
    const source = await this.#dependencies.wordpress.readSource({
      siteId: plan.siteId,
      target: plan.target
    });
    if (
      source.siteId !== plan.siteId ||
      source.postId !== plan.target.postId ||
      source.postType !== plan.target.postType ||
      source.revision !== plan.target.sourceRevision ||
      source.contentHash !== plan.target.sourceContentHash ||
      hashGutenbergV2Content(source.rawContent) !== source.contentHash ||
      hashGutenbergV2Value(source.fields) !== source.fieldsHash
    ) {
      throw new GutenbergV2ServiceError(
        "stale_source",
        "The target post changed after the v2 plan was created."
      );
    }
    for (const field of ["title", "excerpt"] as const) {
      const expected = plan.target.expectedFields[field];
      if (
        expected &&
        hashGutenbergV2Value(source.fields[field]) !== expected.valueHash
      ) {
        throw new GutenbergV2ServiceError(
          "stale_source",
          `The target ${field} changed after the v2 plan was created.`
        );
      }
      if (
        expected?.value !== undefined &&
        expected.value !== source.fields[field]
      ) {
        throw new GutenbergV2ServiceError(
          "stale_source",
          `The target ${field} value does not match its expected source value.`
        );
      }
      if (plan.postFields?.[field] !== undefined && !expected) {
        throw new GutenbergV2ServiceError(
          "stale_source",
          `An update to ${field} requires its expected source hash.`
        );
      }
    }
    return source;
  }

  #assertSupportedPlan(
    plan: GutenbergV2BlockPlan,
    capabilities: GutenbergV2EditorCapabilitySnapshot
  ): void {
    const destination = new Map(
      capabilities.blocks.map((block) => [block.name, block])
    );
    for (const node of walkBlocks(planBlocks(plan))) {
      const policy = staticSupport.get(node.name);
      const block = destination.get(node.name);
      if (!block?.registered)
        throw new GutenbergV2ServiceError(
          "unregistered_block",
          `${node.name} is not registered in the destination editor.`
        );
      if (!block.allowed)
        throw new GutenbergV2ServiceError(
          "disallowed_block",
          `${node.name} is not allowed in this editor context.`
        );
      if (!policy)
        throw new GutenbergV2ServiceError(
          "unsupported_v2_block",
          `${node.name} is outside the v2 release matrix.`
        );
      const accepted =
        policy.mode === "fixture_required"
          ? block.v2Support === "author_when_reviewed"
          : block.v2Support === "author";
      if (!accepted)
        throw new GutenbergV2ServiceError(
          "unsupported_v2_block",
          `${node.name} has not passed its required v2 authoring acceptance gate.`
        );
      if (block.lock !== "none")
        throw new GutenbergV2ServiceError(
          "locked_structure",
          `${node.name} is locked in this editor context.`
        );
    }
  }

  #assertMediaMapping(
    candidate: GutenbergV2CompiledCandidate,
    mapping: GutenbergV2MediaMapping[]
  ): void {
    const approved = new Map(
      candidate.mediaManifest.map((entry) => [entry.ref, entry])
    );
    if (mapping.length !== approved.size)
      throw new GutenbergV2ServiceError(
        "media_changed",
        "The final media mapping does not cover the approved manifest exactly."
      );
    const seen = new Set<string>();
    for (const item of mapping) {
      const manifest = approved.get(item.ref);
      if (
        !manifest ||
        seen.has(item.ref) ||
        manifest.approvedChecksum !== item.approvedChecksum ||
        item.approvedChecksum !== item.finalChecksum
      ) {
        throw new GutenbergV2ServiceError(
          "media_changed",
          `Media ${item.ref} does not match its approved immutable checksum.`
        );
      }
      seen.add(item.ref);
    }
  }

  #assertPreparedCommit(
    job: GutenbergV2JobRecord,
    response: GutenbergV2PrepareCommitResponse,
    request: GutenbergV2PrepareCommitRequest
  ): void {
    const prepared = response.preparedCommit;
    const candidate = job.candidate;
    const expectedPostId = candidate ? planPostId(candidate.intent) : undefined;
    const invalid =
      prepared.executionId !== job.executionId ||
      prepared.idempotencyKey !== job.idempotencyKey ||
      prepared.approvalId !== job.approvalId ||
      prepared.candidateId !== job.candidateId ||
      prepared.siteId !== job.siteId ||
      prepared.operation !== job.candidate?.operation ||
      prepared.postId !== expectedPostId ||
      prepared.sourceRevision !== candidate?.sourceState.revision ||
      prepared.sourceContentHash !== candidate?.sourceState.contentHash ||
      prepared.requestedFieldsHash !== job.candidate?.requestedFieldsHash ||
      prepared.affectedFieldsHash !==
        job.candidate?.sourceState.affectedFieldsHash ||
      prepared.capabilityFingerprint !== job.candidate?.capabilityFingerprint ||
      prepared.intentHash !== job.candidate?.intentHash ||
      prepared.approvedContentHash !== job.candidate?.contentHash ||
      prepared.mediaManifestHash !== job.candidate?.mediaManifestHash ||
      hashGutenbergV2Value(prepared.mediaMapping) !==
        hashGutenbergV2Value(request.mediaMapping) ||
      prepared.finalContentHash !== request.finalContentHash ||
      hashGutenbergV2Content(prepared.finalContent) !==
        prepared.serverPreparedContentHash ||
      Date.parse(prepared.expiresAt) <= Date.parse(this.#now());
    if (invalid)
      throw new GutenbergV2ServiceError(
        "content_changed",
        "The server-prepared commit does not preserve the approved binding."
      );
  }

  #assertCommitReceipt(
    job: GutenbergV2JobRecord,
    receipt: GutenbergV2CommitReceipt
  ): void {
    const candidate = job.candidate;
    if (
      receipt.executionId !== job.executionId ||
      receipt.idempotencyKey !== job.idempotencyKey ||
      receipt.preparedCommitId !== job.preparedCommit?.preparedCommitId ||
      receipt.beforeStateRef !== job.beforeStateRef ||
      (candidate !== undefined &&
        candidate.operation !== "create_draft" &&
        receipt.postId !== planPostId(candidate.intent))
    ) {
      throw new GutenbergV2ServiceError(
        "idempotency_conflict",
        "The commit receipt does not match this prepared execution."
      );
    }
  }

  async #requireCurrentApproval(
    approval: GutenbergV2Approval
  ): Promise<GutenbergV2Approval> {
    const stored = await this.#dependencies.approvals.get(approval.approvalId);
    if (
      !stored ||
      hashGutenbergV2Value(stored) !== hashGutenbergV2Value(approval)
    ) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        "The recorded approval is missing or has changed."
      );
    }
    if (Date.parse(stored.expiresAt) <= Date.parse(this.#now())) {
      throw new GutenbergV2ServiceError(
        "approval_expired",
        "The approval expired before preparation."
      );
    }
    return stored;
  }

  #assertJobIdentity(
    job: GutenbergV2JobRecord,
    executionId: string,
    key: string,
    siteId: string,
    planHash: string
  ): void {
    if (
      job.executionId !== executionId ||
      job.idempotencyKey !== key ||
      job.siteId !== siteId ||
      job.planHash !== planHash
    ) {
      throw new GutenbergV2ServiceError(
        "idempotency_conflict",
        "The execution ID is already bound to different v2 input."
      );
    }
  }

  async #requireJob(executionId: string): Promise<GutenbergV2JobRecord> {
    const job = await this.#dependencies.journal.get(executionId);
    if (!job)
      throw new GutenbergV2ServiceError(
        "idempotency_conflict",
        `Execution ${executionId} does not exist.`
      );
    return job;
  }

  async #transition(
    current: GutenbergV2JobRecord,
    state: GutenbergV2ExecutionState,
    changes: Partial<GutenbergV2JobRecord> = {}
  ): Promise<GutenbergV2JobRecord> {
    if (!ALLOWED_TRANSITIONS[current.state].includes(state)) {
      throw new GutenbergV2ServiceError(
        "idempotency_conflict",
        `Invalid v2 state transition: ${current.state} to ${state}.`
      );
    }
    return this.#replace(current, state, changes);
  }

  async #replaceWithinState(
    current: GutenbergV2JobRecord,
    changes: Partial<GutenbergV2JobRecord>
  ): Promise<GutenbergV2JobRecord> {
    return this.#replace(current, current.state, changes);
  }

  async #replace(
    current: GutenbergV2JobRecord,
    state: GutenbergV2ExecutionState,
    changes: Partial<GutenbergV2JobRecord>
  ): Promise<GutenbergV2JobRecord> {
    const next = gutenbergV2JobRecordSchema.parse({
      ...current,
      ...changes,
      state,
      revision: current.revision + 1,
      updatedAt: this.#now()
    });
    const changed = await this.#dependencies.journal.compareAndSet({
      executionId: current.executionId,
      expectedRevision: current.revision,
      expectedState: current.state,
      next
    });
    if (!changed)
      throw new GutenbergV2ServiceError(
        "idempotency_conflict",
        "Another worker changed the v2 execution journal.",
        { retryable: true }
      );
    return next;
  }

  async #failBeforeWrite(
    job: GutenbergV2JobRecord,
    error: unknown,
    phase: GutenbergV2ValidationIssue["phase"]
  ): Promise<void> {
    const serviceError = this.#normalizeServiceError(error);
    const stale =
      (serviceError.code === "approval_expired" ||
        serviceError.code === "runtime_changed") &&
      (job.state === "approved" ||
        job.state === "preparing" ||
        job.state === "committing");
    await this.#transition(job, stale ? "stale_approval" : "pre_write_failed", {
      failure: issue(serviceError.code, phase, serviceError.message)
    });
  }

  #normalizeServiceError(error: unknown): GutenbergV2ServiceError {
    if (error instanceof GutenbergV2ServiceError) return error;
    const record =
      error !== null && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const parsedCode = gutenbergV2ValidationFailureCodeSchema.safeParse(
      record.code
    );
    const parsedIssues = gutenbergV2ValidationIssueSchema
      .array()
      .safeParse(record.issues);
    return new GutenbergV2ServiceError(
      parsedCode.success ? parsedCode.data : "editor_unavailable",
      typeof record.message === "string" && record.message.trim().length > 0
        ? record.message.slice(0, 2_000)
        : "The v2 operation failed before a content write.",
      {
        retryable:
          typeof record.retryable === "boolean" ? record.retryable : true,
        cause: error,
        ...(parsedIssues.success ? { issues: parsedIssues.data } : {})
      }
    );
  }

  #executionResult(
    job: GutenbergV2JobRecord,
    state: GutenbergV2ExecutionState,
    verification: GutenbergV2ValidationReport,
    rollback: GutenbergV2ExecutionResult["rollback"],
    readback: GutenbergV2Readback
  ): GutenbergV2ExecutionResult {
    return {
      schemaVersion: "sitepilot.execution-result/v2",
      executionId: job.executionId,
      idempotencyKey: job.idempotencyKey,
      state,
      postId: readback.postId,
      persistedRevision: readback.revision,
      persistedContentHash: readback.contentHash,
      persistedFieldsHash: readback.fieldsHash,
      verification,
      beforeStateRef: job.beforeStateRef,
      createdMediaIds: job.createdMediaIds ?? [],
      retry: { retryable: state === "manual_intervention_required" },
      rollback,
      auditRef: `execution:${job.executionId}`,
      completedAt: this.#now()
    };
  }

  #failedVerificationReport(
    report: GutenbergV2ValidationReport,
    message: string
  ): GutenbergV2ValidationReport {
    if (report.outcome === "invalid") return report;
    return gutenbergV2ValidationReportSchema.parse({
      ...report,
      outcome: "invalid",
      issues: [
        ...report.issues,
        issue("persisted_content_invalid", "verify", message)
      ]
    });
  }

  #deterministicVerificationFailureReport(
    approvedReport: GutenbergV2ValidationReport,
    expectedFields: GutenbergV2CompiledCandidate["requestedPostFields"],
    readback: GutenbergV2Readback,
    error: GutenbergV2ServiceError
  ): GutenbergV2ValidationReport {
    const checked = approvedReport.contentPreservation.checked.includes(
      "post_fields"
    )
      ? approvedReport.contentPreservation.checked
      : [...approvedReport.contentPreservation.checked, "post_fields" as const];
    const mismatchedFields = Object.entries(expectedFields).filter(
      ([field, expected]) =>
        expected !== undefined &&
        readback.fields[field as keyof typeof readback.fields] !== expected
    );
    const workerIssues =
      error.issues.length > 0
        ? error.issues
        : [issue(error.code, "verify", error.message)];
    const fieldIssues = mismatchedFields.map(([field]) =>
      issue(
        "persisted_content_invalid",
        "verify",
        `Persisted post field ${field} differs from the approved value.`
      )
    );
    return gutenbergV2ValidationReportSchema.parse({
      ...approvedReport,
      outcome: "invalid",
      issues: [...approvedReport.issues, ...workerIssues, ...fieldIssues],
      contentPreservation: {
        ...approvedReport.contentPreservation,
        passed: false,
        checked
      }
    });
  }

  #now(): string {
    return (this.#dependencies.clock?.now() ?? new Date()).toISOString();
  }

  #id(): string {
    return this.#dependencies.ids?.next() ?? randomUUID();
  }
}
