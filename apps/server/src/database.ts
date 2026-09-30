import type { PoolConfig } from "pg";

import { seedDefaultWorkspace } from "@sitepilot/core/app-database";
import {
  initializePostgresDatabase,
  type PostgresDatabaseContext
} from "@sitepilot/repositories";

/**
 * The hosted database (Supabase Postgres). Connection settings come from the
 * standard libpq variables that `pg` reads itself (PGHOST, PGPORT, PGUSER,
 * PGDATABASE, PGPASSWORD), or from DATABASE_URL.
 */

export type DatabaseStatus =
  | { status: "not_configured" }
  | { status: "connecting"; lastError?: string; attempts: number }
  | { status: "ok"; migrations: number; tls: TlsMode };

export type TlsMode = "verified" | "encrypted_unverified" | "off";

function isLocalHost(host: string | undefined): boolean {
  return (
    host === undefined ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".railway.internal")
  );
}

/**
 * Encrypt every connection that leaves the machine. With Supabase's CA
 * certificate in SITEPILOT_PG_CA_CERT the server is verified too; without it
 * the link is encrypted but the server isn't checked.
 */
export function poolConfigFromEnvironment(env: NodeJS.ProcessEnv): {
  config: PoolConfig;
  tls: TlsMode;
} | null {
  const connectionString = env.DATABASE_URL;
  if (!connectionString && !env.PGHOST) return null;
  const host = connectionString ? new URL(connectionString).hostname : env.PGHOST;
  const ca = env.SITEPILOT_PG_CA_CERT?.trim();
  const tls: TlsMode = isLocalHost(host)
    ? "off"
    : ca
      ? "verified"
      : "encrypted_unverified";
  return {
    tls,
    config: {
      ...(connectionString ? { connectionString } : {}),
      max: 10,
      connectionTimeoutMillis: 10_000,
      ...(tls === "off"
        ? {}
        : {
            ssl:
              tls === "verified"
                ? { ca, rejectUnauthorized: true }
                : { rejectUnauthorized: false }
          })
    }
  };
}

export type ConnectedDatabase = {
  database: PostgresDatabaseContext;
  tls: TlsMode;
};

/**
 * Connects, applies migrations and seeds the default workspace, retrying with
 * backoff until it succeeds or `signal` aborts. The status callback reports
 * progress for the health check.
 */
export async function connectWithRetry(input: {
  env: NodeJS.ProcessEnv;
  onStatus: (status: DatabaseStatus) => void;
  signal: AbortSignal;
  log?: (message: string) => void;
}): Promise<ConnectedDatabase | null> {
  const settings = poolConfigFromEnvironment(input.env);
  if (!settings) {
    input.onStatus({ status: "not_configured" });
    return null;
  }
  let attempts = 0;
  while (!input.signal.aborted) {
    attempts += 1;
    try {
      const database = await initializePostgresDatabase(settings.config);
      await seedDefaultWorkspace(database);
      input.onStatus({
        status: "ok",
        migrations: database.migrations.length,
        tls: settings.tls
      });
      if (settings.tls === "encrypted_unverified") {
        input.log?.(
          "Database connection is encrypted but the server certificate isn't verified. Set SITEPILOT_PG_CA_CERT to Supabase's CA certificate to verify it."
        );
      }
      return { database, tls: settings.tls };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.onStatus({ status: "connecting", lastError: message, attempts });
      input.log?.(`Database connection attempt ${attempts} failed: ${message}`);
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        input.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  return null;
}
