import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureRuntimeContext } from "@sitepilot/core/runtime-context";
import {
  EncryptedSqlSecureStorage,
  parseSecretsKey
} from "@sitepilot/services";

import { createRequestHandler, serverInfoFromEnvironment } from "./app.js";
import { connectWithRetry, type DatabaseStatus } from "./database.js";
import type { SecretsStatus } from "./app.js";

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

const server = createServer(
  createRequestHandler(info, () => databaseStatus, () => secretsStatus)
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
          secureStorage: new EncryptedSqlSecureStorage(
            connected.database.sql,
            secretsKey
          )
        }
      : {})
  });
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
