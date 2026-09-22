import type Database from "better-sqlite3";

import {
  gutenbergV2ApprovalSchema,
  gutenbergV2JobRecordSchema,
  type GutenbergV2Approval,
  type GutenbergV2ExecutionState,
  type GutenbergV2JobRecord
} from "@sitepilot/contracts";

import type { GutenbergV2ApprovalStore } from "./gutenberg-v2-content-service.js";
import { hashGutenbergV2Value } from "./gutenberg-v2-hashing.js";

export type GutenbergV2JournalCreateResult = {
  created: boolean;
  record: GutenbergV2JobRecord;
};

export type GutenbergV2JournalCompareAndSetInput = {
  executionId: string;
  expectedRevision: number;
  expectedState: GutenbergV2ExecutionState;
  next: GutenbergV2JobRecord;
};

export interface GutenbergV2ExecutionJournal {
  get(executionId: string): Promise<GutenbergV2JobRecord | null>;
  create(record: GutenbergV2JobRecord): Promise<GutenbergV2JournalCreateResult>;
  compareAndSet(input: GutenbergV2JournalCompareAndSetInput): Promise<boolean>;
}

type JournalRow = { payload: string };
type ApprovalRow = { payload: string; payloadHash: string };

function ensureTables(connection: Database.Database): void {
  connection.pragma("busy_timeout = 5000");
  connection.exec(`
    CREATE TABLE IF NOT EXISTS gutenberg_v2_execution_journal (
      execution_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gutenberg_v2_execution_idempotency
      ON gutenberg_v2_execution_journal(idempotency_key);
    CREATE TABLE IF NOT EXISTS gutenberg_v2_approvals (
      approval_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export class SqliteGutenbergV2ExecutionJournal implements GutenbergV2ExecutionJournal {
  public constructor(private readonly connection: Database.Database) {
    ensureTables(connection);
  }

  public async get(executionId: string): Promise<GutenbergV2JobRecord | null> {
    const row = this.connection
      .prepare<
        { executionId: string },
        JournalRow
      >("SELECT payload FROM gutenberg_v2_execution_journal WHERE execution_id = @executionId")
      .get({ executionId });
    return row
      ? gutenbergV2JobRecordSchema.parse(JSON.parse(row.payload))
      : null;
  }

  public async create(
    record: GutenbergV2JobRecord
  ): Promise<GutenbergV2JournalCreateResult> {
    const parsed = gutenbergV2JobRecordSchema.parse(record);
    const result = this.connection
      .prepare(
        `INSERT INTO gutenberg_v2_execution_journal
          (execution_id, revision, state, idempotency_key, payload, created_at, updated_at)
         VALUES
          (@executionId, @revision, @state, @idempotencyKey, @payload, @createdAt, @updatedAt)
         ON CONFLICT DO NOTHING`
      )
      .run({
        executionId: parsed.executionId,
        revision: parsed.revision,
        state: parsed.state,
        idempotencyKey: parsed.idempotencyKey,
        payload: JSON.stringify(parsed),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt
      });
    if (result.changes === 1) return { created: true, record: parsed };
    const existing =
      (await this.get(parsed.executionId)) ??
      (() => {
        const row = this.connection
          .prepare<
            { idempotencyKey: string },
            JournalRow
          >("SELECT payload FROM gutenberg_v2_execution_journal WHERE idempotency_key = @idempotencyKey")
          .get({ idempotencyKey: parsed.idempotencyKey });
        return row
          ? gutenbergV2JobRecordSchema.parse(JSON.parse(row.payload))
          : null;
      })();
    if (!existing)
      throw new Error(
        "The v2 journal lost an execution after a conflicting insert."
      );
    return { created: false, record: existing };
  }

  public async compareAndSet(
    input: GutenbergV2JournalCompareAndSetInput
  ): Promise<boolean> {
    const next = gutenbergV2JobRecordSchema.parse(input.next);
    if (
      next.executionId !== input.executionId ||
      next.revision !== input.expectedRevision + 1
    ) {
      throw new TypeError(
        "A journal transition must preserve execution identity and increment revision once."
      );
    }
    const result = this.connection
      .prepare(
        `UPDATE gutenberg_v2_execution_journal
         SET revision = @nextRevision, state = @nextState, payload = @payload, updated_at = @updatedAt
         WHERE execution_id = @executionId AND revision = @expectedRevision AND state = @expectedState`
      )
      .run({
        executionId: input.executionId,
        expectedRevision: input.expectedRevision,
        expectedState: input.expectedState,
        nextRevision: next.revision,
        nextState: next.state,
        payload: JSON.stringify(next),
        updatedAt: next.updatedAt
      });
    return result.changes === 1;
  }
}

export class SqliteGutenbergV2ApprovalStore implements GutenbergV2ApprovalStore {
  public constructor(private readonly connection: Database.Database) {
    ensureTables(connection);
  }

  public async get(approvalId: string): Promise<GutenbergV2Approval | null> {
    const row = this.connection
      .prepare<
        { approvalId: string },
        ApprovalRow
      >(`SELECT payload, payload_hash AS payloadHash FROM gutenberg_v2_approvals WHERE approval_id = @approvalId`)
      .get({ approvalId });
    if (!row) return null;
    const approval = gutenbergV2ApprovalSchema.parse(JSON.parse(row.payload));
    if (hashGutenbergV2Value(approval) !== row.payloadHash) {
      throw new Error(
        `Stored approval ${approvalId} failed its immutable payload hash.`
      );
    }
    return approval;
  }

  public async save(approval: GutenbergV2Approval): Promise<void> {
    const parsed = gutenbergV2ApprovalSchema.parse(approval);
    const payloadHash = hashGutenbergV2Value(parsed);
    const result = this.connection
      .prepare(
        `INSERT INTO gutenberg_v2_approvals
          (approval_id, candidate_id, expires_at, payload_hash, payload, created_at)
         VALUES
          (@approvalId, @candidateId, @expiresAt, @payloadHash, @payload, @createdAt)
         ON CONFLICT(approval_id) DO NOTHING`
      )
      .run({
        approvalId: parsed.approvalId,
        candidateId: parsed.binding.candidateId,
        expiresAt: parsed.expiresAt,
        payloadHash,
        payload: JSON.stringify(parsed),
        createdAt: parsed.approvedAt
      });
    if (result.changes === 1) return;
    const existing = await this.get(parsed.approvalId);
    if (!existing || hashGutenbergV2Value(existing) !== payloadHash) {
      throw new Error(
        `Approval ${parsed.approvalId} is already bound to another immutable payload.`
      );
    }
  }
}
