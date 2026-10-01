import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDesktopMcpBackend } from "@sitepilot/core/mcp-backend";
import { configureRuntimeContext } from "@sitepilot/core/runtime-context";
import {
  EncryptedSqlSecureStorage,
  parseSecretsKey,
  type SecureStorage
} from "@sitepilot/services";

import {
  createRequestHandler,
  serverInfoFromEnvironment,
  type Routes,
  type SecretsStatus
} from "./app.js";
import { AuthStore } from "./auth.js";
import { connectWithRetry, type DatabaseStatus } from "./database.js";
import { createHostedMcpHandler } from "./mcp.js";
import { createAppShell } from "./app-shell.js";
import { createRoutes } from "./routes.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const info = serverInfoFromEnvironment();
let databaseStatus: DatabaseStatus = { status: "not_configured" };
// Site secrets and approval keys are encrypted under this key. It never
// leaves the environment and is never logged.
const secretsKey = parseSecretsKey(process.env.SITEPILOT_SECRETS_KEY);
let secretsStatus: SecretsStatus = process.env.SITEPILOT_SECRETS_KEY
  ? secretsKey
    ? "waiting_for_database"
    : "invalid_key"
  : "not_configured";
const shutdownController = new AbortController();
let routes: Routes | null = null;

// The address people and WordPress reach this server at. Railway sets
// RAILWAY_PUBLIC_DOMAIN once the service has a domain.
const publicUrl = new URL(
  process.env.SITEPILOT_PUBLIC_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${port}`)
);

/**
 * Planner keys can come from the environment (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY) instead of being saved through the app.
 */
function withProviderKeysFromEnvironment(storage: SecureStorage): SecureStorage {
  const fromEnvironment: Record<string, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY
  };
  const envValue = (key: { namespace: string; keyId: string }) =>
    key.namespace === "provider" ? fromEnvironment[key.keyId] : undefined;
  return {
    get: async (key) => envValue(key) ?? storage.get(key),
    has: async (key) => envValue(key) !== undefined || storage.has(key),
    set: (key, value) => storage.set(key, value),
    delete: (key) => storage.delete(key)
  };
}

const server = createServer(
  createRequestHandler(info, () => databaseStatus, () => secretsStatus, () => routes)
);

// "::" accepts IPv4 and IPv6. Railway's private network is IPv6-only.
server.listen(port, "::", () => {
  console.log(
    `SitePilot server ${info.version}${info.commit ? ` (${info.commit})` : ""} listening on port ${port}.`
  );
});

// Review artifacts and staged media are files for now. On Railway this is
// the container's disk; it moves to Supabase Storage later.
const dataDirectory =
  process.env.SITEPILOT_DATA_DIR ?? join(tmpdir(), "sitepilot-server");
mkdirSync(dataDirectory, { recursive: true });

const connecting = connectWithRetry({
  env: process.env,
  signal: shutdownController.signal,
  onStatus: (status) => {
    databaseStatus = status;
  },
  log: (message) => console.log(message)
}).then((connected) => {
  if (!connected) return null;
  configureRuntimeContext({
    userDataPath: dataDirectory,
    database: connected.database,
    ...(secretsKey
      ? {
          secureStorage: withProviderKeysFromEnvironment(
            new EncryptedSqlSecureStorage(connected.database.sql, secretsKey)
          )
        }
      : {})
  });
  // The app needs somewhere to keep site secrets before it can serve.
  if (secretsKey) {
    const auth = new AuthStore(connected.database.sql);
    const backend = createDesktopMcpBackend({
      siteScope: "all",
      approvalHint: `Open SitePilot at ${publicUrl.origin}, open the request and approve it there. MCP clients cannot approve.`
    });
    const app = createAppShell({ appVersion: info.version });
    routes = createRoutes({
      publicUrl,
      allowedSiteUrl: process.env.SITEPILOT_SITE_URL ? new URL(process.env.SITEPILOT_SITE_URL) : null,
      auth,
      backend,
      mcp: createHostedMcpHandler({ auth, backend, version: info.version }),
      app
    });
    console.log(
      `Serving the app at ${publicUrl.origin}${app.available ? "" : " (simple pages; the desktop interface build isn't present)"}.`
    );
  }
  if (secretsKey) secretsStatus = "ok";
  console.log(
    secretsStatus === "ok"
      ? "Secure storage: on, encrypted in the database."
      : secretsStatus === "invalid_key"
        ? "Secure storage: off. SITEPILOT_SECRETS_KEY is set but isn't 32 bytes of base64."
        : "Secure storage: off. SITEPILOT_SECRETS_KEY isn't set."
  );
  console.log(
    `Database ready: ${connected.database.migrations.length} migration(s) applied, TLS ${connected.tls}.`
  );
  return connected;
});

function shutdown(signal: string): void {
  console.log(`${signal} received; closing the server.`);
  shutdownController.abort();
  server.close(() => {
    void connecting
      .then((connected) => connected?.database.close())
      .finally(() => process.exit(0));
  });
  // Don't let a slow connection hold up a redeploy.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
