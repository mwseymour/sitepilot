import Database from "better-sqlite3";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compileNamedParameters,
  postgresConnection,
  sqliteConnection,
  type SqlConnection
} from "@sitepilot/sql";

/**
 * The same behaviour on both databases. The Postgres half runs when
 * SITEPILOT_TEST_POSTGRES_URL points at a disposable database.
 */
const POSTGRES_URL = process.env.SITEPILOT_TEST_POSTGRES_URL;

describe("compileNamedParameters", () => {
  it("numbers each name once, in order of first use", () => {
    expect(
      compileNamedParameters(
        "UPDATE t SET a = @a, b = @b WHERE id = @id AND a <> @a"
      )
    ).toEqual({
      text: "UPDATE t SET a = $1, b = $2 WHERE id = $3 AND a <> $1",
      names: ["a", "b", "id"]
    });
  });

  it("leaves quoted literals and identifiers alone", () => {
    expect(
      compileNamedParameters(
        `SELECT '@not_a_param', 'it''s @x', "col@x" AS "fooBar" FROM t WHERE a = @real`
      )
    ).toEqual({
      text: `SELECT '@not_a_param', 'it''s @x', "col@x" AS "fooBar" FROM t WHERE a = $1`,
      names: ["real"]
    });
  });
});

function contract(name: string, open: () => Promise<{ sql: SqlConnection; close: () => Promise<void> }>) {
  describe(`${name} connection`, () => {
    let sql: SqlConnection;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ sql, close } = await open());
      await sql.exec(`DROP TABLE IF EXISTS sql_contract_items`);
      await sql.exec(`CREATE TABLE sql_contract_items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )`);
    });

    afterAll(async () => {
      await sql?.exec(`DROP TABLE IF EXISTS sql_contract_items`);
      await close?.();
    });

    it("upserts, reads back and reports changed rows", async () => {
      const upsert = sql.prepare(
        `INSERT INTO sql_contract_items (id, label, count) VALUES (@id, @label, @count)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, count = excluded.count`
      );
      expect((await upsert.run({ id: "a", label: "first", count: 1 })).changes).toBe(1);
      expect((await upsert.run({ id: "a", label: "second", count: 2 })).changes).toBe(1);
      await upsert.run({ id: "b", label: "other", count: 3 });

      const row = await sql
        .prepare<{ id: string }, { id: string; itemLabel: string; count: number }>(
          `SELECT id, label AS "itemLabel", count FROM sql_contract_items WHERE id = @id`
        )
        .get({ id: "a" });
      expect(row).toEqual({ id: "a", itemLabel: "second", count: 2 });
      expect(
        await sql
          .prepare<{ id: string }, { id: string }>(
            `SELECT id FROM sql_contract_items WHERE id = @id`
          )
          .get({ id: "missing" })
      ).toBeUndefined();
      const rows = await sql
        .prepare<[], { id: string }>(`SELECT id FROM sql_contract_items ORDER BY id`)
        .all();
      expect(rows.map((item) => item.id)).toEqual(["a", "b"]);
    });

    it("compare-and-set changes nothing when the guard fails", async () => {
      const cas = sql.prepare(
        `UPDATE sql_contract_items SET count = @next WHERE id = @id AND count = @expected`
      );
      expect((await cas.run({ id: "b", expected: 99, next: 4 })).changes).toBe(0);
      expect((await cas.run({ id: "b", expected: 3, next: 4 })).changes).toBe(1);
    });

    it("stores nulls for undefined values", async () => {
      await sql.exec(`CREATE TABLE IF NOT EXISTS sql_contract_nullable (id TEXT PRIMARY KEY, note TEXT)`);
      await sql
        .prepare(`INSERT INTO sql_contract_nullable (id, note) VALUES (@id, @note)`)
        .run({ id: "n", note: undefined });
      const row = await sql
        .prepare<{ id: string }, { note: string | null }>(`SELECT note FROM sql_contract_nullable WHERE id = @id`)
        .get({ id: "n" });
      expect(row).toEqual({ note: null });
      await sql.exec(`DROP TABLE sql_contract_nullable`);
    });

    it("commits a transaction, and rolls it back on error", async () => {
      await sql.transaction(async (tx) => {
        await tx
          .prepare(`INSERT INTO sql_contract_items (id, label) VALUES (@id, @label)`)
          .run({ id: "t1", label: "committed" });
      });
      await expect(
        sql.transaction(async (tx) => {
          await tx
            .prepare(`INSERT INTO sql_contract_items (id, label) VALUES (@id, @label)`)
            .run({ id: "t2", label: "rolled back" });
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      const ids = (
        await sql
          .prepare<[], { id: string }>(`SELECT id FROM sql_contract_items WHERE id LIKE 't%' ORDER BY id`)
          .all()
      ).map((row) => row.id);
      expect(ids).toEqual(["t1"]);
    });
  });
}

contract("SQLite", async () => {
  const database = new Database(":memory:");
  return { sql: sqliteConnection(database), close: async () => database.close() };
});

if (POSTGRES_URL) {
  contract("Postgres", async () => {
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 3 });
    return { sql: postgresConnection(pool), close: () => pool.end() };
  });

  describe("Postgres parameters", () => {
    it("refuses a statement with a missing named parameter", async () => {
      const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 });
      try {
        await expect(
          postgresConnection(pool).prepare(`SELECT @present, @absent`).get({ present: 1 })
        ).rejects.toThrow('Missing named parameter "absent".');
      } finally {
        await pool.end();
      }
    });
  });
}
