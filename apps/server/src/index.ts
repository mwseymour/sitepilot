import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureRuntimeContext } from "@sitepilot/core/runtime-context";

import { createRequestHandler, serverInfoFromEnvironment } from "./app.js";
import { connectWithRetry, type DatabaseStatus } from "./database.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const info = serverInfoFromEnvironment();
let databaseStatus: DatabaseStatus = { status: "not_configured" };
const shutdownController = new AbortController();

const server = createServer(
  createRequestHandler(info, () => databaseStatus)
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
    database: connected.database
  });
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
