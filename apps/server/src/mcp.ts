import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createSitePilotMcpServer,
  type SitePilotMcpBackend
} from "@sitepilot/mcp-server";

import type { AuthStore, SignedInUser } from "./auth.js";
import { readBody } from "./http.js";

/**
 * SitePilot's MCP server for Claude Code, Codex and other clients, over
 * Streamable HTTP with a personal token (Authorization: Bearer spt_…). Each
 * session acts as the token's owner, with their WordPress-derived role; as on
 * the desktop, no tool can approve or write to WordPress.
 */

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenOwner: string;
  lastUsedAt: number;
};

const IDLE_TIMEOUT_MS = 30 * 60_000;

function rpcError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function bearer(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(spt_[A-Za-z0-9_-]{20,})$/i.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

export function createHostedMcpHandler(input: {
  auth: AuthStore;
  backend: SitePilotMcpBackend;
  version: string;
}) {
  const sessions = new Map<string, Session>();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [id, session] of sessions) {
      if (session.lastUsedAt < cutoff) {
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    }
  }, 60_000);
  sweep.unref();

  function serverFor(user: SignedInUser): McpServer {
    let server: McpServer | undefined;
    server = createSitePilotMcpServer({
      backend: input.backend,
      version: input.version,
      caller: () => {
        const clientName = server?.server.getClientVersion()?.name;
        return {
          ...(clientName !== undefined ? { clientName } : {}),
          actor: {
            userProfileId: user.userProfileId,
            appRole: user.appRole,
            siteRoles: user.siteRoles
          }
        };
      }
    });
    return server;
  }

  return async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const token = bearer(request);
    const user = token ? await input.auth.userForApiToken(token) : null;
    if (!token || !user) {
      response.setHeader("www-authenticate", 'Bearer realm="sitepilot"');
      rpcError(response, 401, "Missing, revoked or unknown SitePilot token. Create one on your SitePilot account page.");
      return;
    }
    const header = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    // A session only ever serves the token that opened it.
    if (existing && existing.tokenOwner !== user.userProfileId) {
      rpcError(response, 403, "This MCP session belongs to someone else.");
      return;
    }

    if (request.method === "POST") {
      let body: unknown;
      try {
        const text = await readBody(request, 30_000_000);
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        rpcError(response, 400, "Invalid JSON-RPC request.");
        return;
      }
      if (existing) {
        existing.lastUsedAt = Date.now();
        await existing.transport.handleRequest(request, response, body);
        return;
      }
      if (sessionId !== undefined || !isInitializeRequest(body)) {
        rpcError(response, 404, "Unknown or expired MCP session. Reconnect.");
        return;
      }
      const server = serverFor(user);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, tokenOwner: user.userProfileId, lastUsedAt: Date.now() });
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      // The SDK's optional callbacks trip exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      if (!existing) {
        rpcError(response, 404, "Unknown or expired MCP session.");
        return;
      }
      existing.lastUsedAt = Date.now();
      await existing.transport.handleRequest(request, response);
      return;
    }

    response.setHeader("allow", "GET, POST, DELETE");
    rpcError(response, 405, "Method not allowed.");
  };
}
