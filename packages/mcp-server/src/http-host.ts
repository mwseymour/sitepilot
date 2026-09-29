import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export type LocalMcpHttpServerOptions = {
  /** 0 picks a free port. */
  port: number;
  /** Every request must send `Authorization: Bearer <token>`. */
  token: string;
  /** A fresh MCP server for each client session. */
  createServer: () => McpServer;
  /** Sessions idle for longer than this are closed. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  /** Called when a request is refused, for diagnostics. */
  onRejected?: (reason: string) => void;
};

export type LocalMcpHttpServer = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsedAt: number;
};

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 30 * 1024 * 1024;

function tokensMatch(expected: string, header: string | undefined): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1].trim());
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function isLocalHostHeader(host: string | undefined, port: number): boolean {
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`
  );
}

/** Browsers send Origin; a local MCP client usually sends none. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  message: string
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null
    })
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : undefined;
}

/**
 * Serve SitePilot MCP over Streamable HTTP on 127.0.0.1 only, behind a bearer
 * token. Used by the desktop app so local Claude and Codex clients can connect.
 */
export async function startLocalMcpHttpServer(
  options: LocalMcpHttpServerOptions
): Promise<LocalMcpHttpServer> {
  const sessions = new Map<string, Session>();
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  let boundPort = options.port;

  const reject = (res: ServerResponse, status: number, reason: string) => {
    options.onRejected?.(reason);
    sendJsonError(res, status, reason);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      reject(res, 404, "Not found. The SitePilot MCP endpoint is /mcp.");
      return;
    }
    if (!isLocalHostHeader(req.headers.host, boundPort)) {
      reject(res, 403, "Host not allowed.");
      return;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      reject(res, 403, "Origin not allowed.");
      return;
    }
    if (!tokensMatch(options.token, req.headers.authorization)) {
      res.setHeader("www-authenticate", 'Bearer realm="sitepilot"');
      reject(res, 401, "Missing or wrong SitePilot MCP token.");
      return;
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        reject(
          res,
          400,
          error instanceof Error ? error.message : "Invalid request body."
        );
        return;
      }
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        existing.lastUsedAt = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (sessionId !== undefined || !isInitializeRequest(body)) {
        reject(res, 404, "Unknown or expired MCP session. Reconnect.");
        return;
      }
      const server = options.createServer();
      const transport: StreamableHTTPServerTransport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, lastUsedAt: Date.now() });
          }
        });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      // The SDK's optional callbacks trip exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (!existing) {
        reject(res, 404, "Unknown or expired MCP session.");
        return;
      }
      existing.lastUsedAt = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    res.setHeader("allow", "GET, POST, DELETE");
    reject(res, 405, "Method not allowed.");
  }

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJsonError(
          res,
          500,
          error instanceof Error ? error.message : "Internal error."
        );
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  boundPort = (httpServer.address() as AddressInfo).port;

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [id, session] of sessions) {
      if (session.lastUsedAt < cutoff) {
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
        void session.server.close().catch(() => undefined);
      }
    }
  }, 60_000);
  sweep.unref();

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}${MCP_PATH}`,
    close: async () => {
      clearInterval(sweep);
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    }
  };
}
