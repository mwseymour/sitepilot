import type { SqlConnection } from "@sitepilot/sql";

/**
 * A durable copy of SitePilot's private files (review previews, staged
 * media) for hosts whose disk doesn't survive a deploy, such as the hosted
 * server's container. The file stores write through to it, and read from it
 * when their own copy is gone.
 */
export interface StoredFileMirror {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

/** The mirror in the hosted Postgres database (`stored_files`, migration 004). */
export class SqlStoredFileMirror implements StoredFileMirror {
  readonly #sql: SqlConnection;
  readonly #namespace: string;

  public constructor(sql: SqlConnection, namespace: string) {
    this.#sql = sql;
    this.#namespace = namespace;
  }

  public async put(key: string, data: Buffer): Promise<void> {
    // Files are immutable under their key, so a second write is a no-op.
    await this.#sql
      .prepare(
        `INSERT INTO stored_files (key, data, created_at) VALUES (@key, @data, @createdAt)
         ON CONFLICT (key) DO NOTHING`
      )
      .run({ key: `${this.#namespace}/${key}`, data, createdAt: new Date().toISOString() });
  }

  public async get(key: string): Promise<Buffer | null> {
    const row = await this.#sql
      .prepare<{ key: string }, { data: Buffer }>(
        `SELECT data FROM stored_files WHERE key = @key`
      )
      .get({ key: `${this.#namespace}/${key}` });
    return row ? Buffer.from(row.data) : null;
  }
}
