import { createServer } from "node:http";

import { createRequestHandler, serverInfoFromEnvironment } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const info = serverInfoFromEnvironment();
const server = createServer(createRequestHandler(info));

// "::" accepts IPv4 and IPv6. Railway's private network is IPv6-only.
server.listen(port, "::", () => {
  console.log(
    `SitePilot server ${info.version}${info.commit ? ` (${info.commit})` : ""} listening on port ${port}.`
  );
});

function shutdown(signal: string): void {
  console.log(`${signal} received; closing the server.`);
  server.close(() => process.exit(0));
  // Don't let a slow connection hold up a redeploy.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
