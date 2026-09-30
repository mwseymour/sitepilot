import type { IncomingMessage, ServerResponse } from "node:http";

import type { DatabaseStatus } from "./database.js";

/**
 * SitePilot's hosted backend (MCP plan, Phase 5). It runs the same services
 * as the desktop app (@sitepilot/core) on Supabase Postgres. So far it only
 * answers the health check; the request, review and MCP routes come next.
 */

export const SERVER_VERSION = "0.1.0";

export type ServerInfo = {
  version: string;
  /** The deployed commit, shortened. Null outside Railway. */
  commit: string | null;
  region: string | null;
  startedAt: string;
};

export function serverInfoFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): ServerInfo {
  return {
    version: SERVER_VERSION,
    commit: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    region: env.RAILWAY_REPLICA_REGION ?? null,
    startedAt: now.toISOString()
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  method: string | undefined
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(method === "HEAD" ? undefined : text);
}

export function createRequestHandler(
  info: ServerInfo,
  databaseStatus: () => DatabaseStatus = () => ({ status: "not_configured" })
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const readOnly = request.method === "GET" || request.method === "HEAD";
    // The process is up even while the database is still connecting, so
    // this stays 200; the body says how the database is doing.
    if (path === "/healthz" && readOnly) {
      const database = databaseStatus();
      sendJson(
        response,
        200,
        {
          status: "ok",
          service: "sitepilot-server",
          ...info,
          database:
            database.status === "connecting"
              ? { status: "connecting", attempts: database.attempts }
              : database
        },
        request.method
      );
      return;
    }
    // sitepilot.error/v1, like every other SitePilot error.
    sendJson(
      response,
      404,
      {
        code: "not_found",
        cause: "not_found",
        retryable: false,
        message: "SitePilot's server has no route here."
      },
      request.method
    );
  };
}
