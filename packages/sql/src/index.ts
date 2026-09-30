import type Database from "better-sqlite3";
import type { Pool, PoolClient, QueryResult } from "pg";

/**
 * One async SQL interface for SitePilot's two databases: SQLite in the
 * desktop app and Postgres (Supabase) on the hosted backend. Statements name
 * their parameters `@name` on both, so repositories share one implementation.
 *
 * Keep shared SQL portable: ISO timestamps as TEXT, booleans as 0/1 INTEGER,
 * `ON CONFLICT` upserts, and double-quoted camelCase aliases (`AS "fooBar"`),
 * since Postgres lowercases bare identifiers.
 */

export type SqlDialect = "sqlite" | "postgres";
export type SqlParams = Record<string, unknown>;
export type SqlRunResult = { changes: number };

export interface SqlStatement<TParams, TRow> {
  get(params?: TParams): Promise<TRow | undefined>;
  all(params?: TParams): Promise<TRow[]>;
  run(params?: TParams): Promise<SqlRunResult>;
}

export interface SqlConnection {
  readonly dialect: SqlDialect;
  prepare<TParams = SqlParams, TRow = unknown>(
    sql: string
  ): SqlStatement<TParams, TRow>;
  /** Runs one or more statements without parameters, such as DDL. */
  exec(sql: string): Promise<void>;
  /** Runs `work` in one transaction, committed when it resolves. */
  transaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// SQLite

class SqliteConnection implements SqlConnection {
  public readonly dialect = "sqlite" as const;
  #inTransaction = false;

  public constructor(private readonly database: Database.Database) {}

  public prepare<TParams = SqlParams, TRow = unknown>(
    sql: string
  ): SqlStatement<TParams, TRow> {
    const statement = this.database.prepare(sql);
    const bind = (params: TParams | undefined): unknown[] =>
      params === undefined || Array.isArray(params) ? [] : [params];
    return {
      get: async (params) =>
        statement.get(...bind(params)) as TRow | undefined,
      all: async (params) => statement.all(...bind(params)) as TRow[],
      run: async (params) => ({ changes: statement.run(...bind(params)).changes })
    };
  }

  public async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  public async transaction<T>(
    work: (tx: SqlConnection) => Promise<T>
  ): Promise<T> {
    if (this.#inTransaction) {
      throw new Error("SQLite transactions don't nest.");
    }
    this.#inTransaction = true;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }
}

export function sqliteConnection(database: Database.Database): SqlConnection {
  return new SqliteConnection(database);
}

// ---------------------------------------------------------------------------
// Postgres

type Compiled = { text: string; names: string[] };

const compiledCache = new Map<string, Compiled>();

/**
 * Rewrites `@name` parameters as `$1`, `$2`, … Quoted literals and
 * identifiers are copied untouched, so an `@` inside them is left alone.
 */
export function compileNamedParameters(sql: string): Compiled {
  const cached = compiledCache.get(sql);
  if (cached) return cached;
  const names: string[] = [];
  const positions = new Map<string, number>();
  let text = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      text += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "@" && /[A-Za-z_]/.test(sql[index + 1] ?? "")) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] as string)) {
        end += 1;
      }
      const name = sql.slice(index + 1, end);
      let position = positions.get(name);
      if (position === undefined) {
        names.push(name);
        position = names.length;
        positions.set(name, position);
      }
      text += `$${position}`;
      index = end;
      continue;
    }
    text += char;
    index += 1;
  }
  const compiled = { text, names };
  compiledCache.set(sql, compiled);
  return compiled;
}

type Queryable = Pick<Pool | PoolClient, "query">;

class PostgresConnection implements SqlConnection {
  public readonly dialect = "postgres" as const;

  public constructor(
    private readonly queryable: Queryable,
    private readonly pool: Pool | null
  ) {}

  public prepare<TParams = SqlParams, TRow = unknown>(
    sql: string
  ): SqlStatement<TParams, TRow> {
    const { text, names } = compileNamedParameters(sql);
    const execute = async (params: TParams | undefined): Promise<QueryResult> => {
      const record =
        params !== undefined && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const values = names.map((name) => {
        if (!Object.hasOwn(record, name)) {
          throw new Error(`Missing named parameter "${name}".`);
        }
        return record[name] === undefined ? null : record[name];
      });
      return this.queryable.query(text, values);
    };
    return {
      get: async (params) => (await execute(params)).rows[0] as TRow | undefined,
      all: async (params) => (await execute(params)).rows as TRow[],
      run: async (params) => ({ changes: (await execute(params)).rowCount ?? 0 })
    };
  }

  public async exec(sql: string): Promise<void> {
    await this.queryable.query(sql);
  }

  public async transaction<T>(
    work: (tx: SqlConnection) => Promise<T>
  ): Promise<T> {
    if (!this.pool) {
      throw new Error("Postgres transactions don't nest.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresConnection(client, null));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function postgresConnection(pool: Pool): SqlConnection {
  return new PostgresConnection(pool, pool);
}
