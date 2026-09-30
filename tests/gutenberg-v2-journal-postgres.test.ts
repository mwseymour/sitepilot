import { afterEach, describe, expect, it } from "vitest";

import type { GutenbergV2Approval } from "@sitepilot/contracts";
import { initializePostgresDatabase } from "@sitepilot/repositories";
import {
  SqlGutenbergV2ApprovalStore,
  SqlGutenbergV2ExecutionJournal
} from "@sitepilot/services";

import {
  TEST_POSTGRES_URL,
  createTestPostgresDatabase
} from "./postgres-test-database.js";

/** The hosted journal: the same compare-and-set guarantees as on SQLite. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function twoConnections() {
  const created = await createTestPostgresDatabase();
  cleanups.push(created.drop);
  const first = await initializePostgresDatabase({ connectionString: created.url, max: 2 });
  cleanups.push(first.close);
  // A second pool, as a second server replica would have.
  const second = await initializePostgresDatabase({ connectionString: created.url, max: 2 });
  cleanups.push(second.close);
  return { first: first.sql, second: second.sql };
}

const now = "2026-09-30T12:00:00.000Z";

describe.skipIf(!TEST_POSTGRES_URL)("Postgres v2 journal", () => {
  it("lets exactly one of two replicas win a transition", async () => {
    const { first, second } = await twoConnections();
    const journals = [
      new SqlGutenbergV2ExecutionJournal(first),
      new SqlGutenbergV2ExecutionJournal(second)
    ] as const;
    const base = {
      schemaVersion: "sitepilot.execution-journal/v2" as const,
      executionId: "pg-cas-execution",
      idempotencyKey: "pg-cas-key",
      siteId: "site-1",
      planHash: "8".repeat(64),
      state: "planned" as const,
      revision: 0,
      createdAt: now,
      updatedAt: now
    };
    expect((await journals[0].create(base)).created).toBe(true);
    // Creating again, from either replica, returns the stored record.
    const again = await journals[1].create({ ...base, updatedAt: "2026-09-30T12:05:00.000Z" });
    expect(again).toEqual({ created: false, record: base });

    const next = { ...base, state: "compiling" as const, revision: 1 };
    const outcomes = await Promise.all(
      journals.map((journal) =>
        journal.compareAndSet({
          executionId: base.executionId,
          expectedRevision: 0,
          expectedState: "planned",
          next
        })
      )
    );
    expect([...outcomes].sort()).toEqual([false, true]);
    expect(await journals[1].get(base.executionId)).toEqual(next);
  });

  it("keeps approvals immutable across replicas", async () => {
    const { first, second } = await twoConnections();
    const stores = [
      new SqlGutenbergV2ApprovalStore(first),
      new SqlGutenbergV2ApprovalStore(second)
    ] as const;
    const approval: GutenbergV2Approval = {
      schemaVersion: "sitepilot.approval/v2",
      approvalId: "pg-approval",
      approverId: "approver-1",
      approvedAt: now,
      expiresAt: "2026-09-30T12:30:00.000Z",
      binding: {
        candidateId: "candidate-1",
        siteId: "site-1",
        operation: "create_draft",
        intentHash: "a".repeat(64),
        contentHash: "b".repeat(64),
        requestedFieldsHash: "c".repeat(64),
        affectedFieldsHash: "d".repeat(64),
        capabilityFingerprint: "e".repeat(64),
        mediaManifestHash: "f".repeat(64)
      }
    };
    await stores[0].save(approval);
    await stores[0].save(approval);
    expect(await stores[1].get(approval.approvalId)).toEqual(approval);
    await expect(
      stores[1].save({ ...approval, approverId: "someone-else" })
    ).rejects.toThrow("already bound to another immutable payload");
    expect(await stores[1].get("missing")).toBeNull();
  });
});
