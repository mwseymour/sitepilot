import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializePostgresDatabase,
  postgresMigrations
} from "@sitepilot/repositories";

import {
  TEST_POSTGRES_URL,
  createTestPostgresDatabase
} from "./postgres-test-database.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function query<T extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!TEST_POSTGRES_URL)("Postgres migrations", () => {
  it("apply once, even when two replicas start together", async () => {
    const created = await createTestPostgresDatabase();
    cleanups.push(created.drop);
    const [first, second] = await Promise.all([
      initializePostgresDatabase({ connectionString: created.url, max: 2 }),
      initializePostgresDatabase({ connectionString: created.url, max: 2 })
    ]);
    cleanups.push(first.close, second.close);
    const ids = postgresMigrations.map((migration) => migration.id);
    expect(first.migrations.map((m) => m.id)).toEqual(ids);
    expect(second.migrations.map((m) => m.id)).toEqual(ids);

    const reopened = await initializePostgresDatabase({ connectionString: created.url, max: 1 });
    cleanups.push(reopened.close);
    expect(reopened.migrations).toEqual(first.migrations);
  });

  it("keeps every table out of the public schema", async () => {
    const created = await createTestPostgresDatabase();
    cleanups.push(created.drop);
    const database = await initializePostgresDatabase({ connectionString: created.url, max: 1 });
    cleanups.push(database.close);
    const tables = await query<{ table_schema: string; table_name: string }>(
      created.url,
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`
    );
    expect(new Set(tables.map((table) => table.table_schema))).toEqual(new Set(["sitepilot"]));
    expect(tables.map((table) => table.table_name)).toEqual(
      expect.arrayContaining([
        "sites",
        "chat_threads",
        "requests",
        "gutenberg_v2_execution_journal",
        "gutenberg_v2_approvals",
        "schema_migrations"
      ])
    );
  });

  it("gives Supabase's API roles no access", async () => {
    const created = await createTestPostgresDatabase();
    cleanups.push(created.drop);
    // Roles are server-wide; create Supabase's two API roles if missing.
    await query(
      created.url,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
       END $$`
    );
    // Supabase grants them the schema by default; the migration must undo it.
    await query(created.url, `CREATE SCHEMA sitepilot`);
    await query(created.url, `GRANT USAGE ON SCHEMA sitepilot TO anon, authenticated`);
    await query(
      created.url,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA sitepilot GRANT ALL ON TABLES TO anon, authenticated`
    );
    const database = await initializePostgresDatabase({ connectionString: created.url, max: 1 });
    cleanups.push(database.close);
    const privileges = await query<{ role: string; usage: boolean; select: boolean }>(
      created.url,
      `SELECT r AS role,
              has_schema_privilege(r, 'sitepilot', 'USAGE') AS usage,
              has_table_privilege(r, 'sitepilot.requests', 'SELECT') AS select
       FROM unnest(ARRAY['anon', 'authenticated']) AS r`
    );
    expect(privileges).toEqual([
      { role: "anon", usage: false, select: false },
      { role: "authenticated", usage: false, select: false }
    ]);
  });
});
