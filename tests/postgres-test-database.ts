import { randomUUID } from "node:crypto";

import pg from "pg";

/**
 * Disposable Postgres databases for tests. Set SITEPILOT_TEST_POSTGRES_URL to
 * a server where the user may create databases, for example the local
 * container: postgres://postgres@127.0.0.1:55432/sitepilot_test
 */
export const TEST_POSTGRES_URL = process.env.SITEPILOT_TEST_POSTGRES_URL;

/** Creates an empty database and returns its URL and a cleanup. */
export async function createTestPostgresDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  if (!TEST_POSTGRES_URL) {
    throw new Error("SITEPILOT_TEST_POSTGRES_URL is not set.");
  }
  const name = `sitepilot_t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: TEST_POSTGRES_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: TEST_POSTGRES_URL });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    }
  };
}
