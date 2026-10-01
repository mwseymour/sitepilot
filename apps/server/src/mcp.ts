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
import type { SitePilotOAuthProvider } from "./oauth.js";

/**
 * SitePilot's MCP server for claude.ai, Claude Code, Codex and other clients,
 * over Streamable HTTP. A client signs in with OAuth (Bearer spa_…, see
 * oauth.ts) or a personal token from the account page (Bearer spt_…). Each
 * session acts as that person, with their WordPress-derived role and, for
 * OAuth, only the scopes they allowed; as on the desktop, no tool can approve
 * or write to WordPress.
 */

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Who opened it, with which scopes and client: later requests must match. */
  owner: string;
  lastUsedAt: number;
};

type Principal = {
  user: SignedInUser;
  /** OAuth only: the allowed scopes, and the client as registered. */
  scopes?: readonly string[];
  clientName?: string;
};

const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Per person, across all their apps and tokens. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 120;

function rpcError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function bearer(request: IncomingMessage): string | null {
  const match = /^Bearer\s+((?:spt|spa)_[A-Za-z0-9_-]{20,})$/i.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

export function createHostedMcpHandler(input: {
  auth: AuthStore;
  backend: SitePilotMcpBackend;
  version: string;
  oauth?: SitePilotOAuthProvider;
  /** Where clients discover how to sign in (RFC 9728), sent with every 401. */
  resourceMetadataUrl?: string;
}) {
  const sessions = new Map<string, Session>();
  const windows = new Map<string, { startedAt: number; count: number }>();

  function overLimit(userProfileId: string): boolean {
    const now = Date.now();
    let window = windows.get(userProfileId);
    if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
      window = { startedAt: now, count: 0 };
      windows.set(userProfileId, window);
    }
    window.count += 1;
    return window.count > RATE_MAX_REQUESTS;
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [id, session] of sessions) {
      if (session.lastUsedAt < cutoff) {
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    }
    for (const [key, window] of windows) {
      if (Date.now() - window.startedAt >= RATE_WINDOW_MS) windows.delete(key);
    }
  }, 60_000);
  sweep.unref();

  async function principalFor(token: string): Promise<Principal | null> {
    if (token.startsWith("spa_")) {
      const caller = input.oauth ? await input.oauth.callerForAccessToken(token) : null;
      return caller ? { user: caller.user, scopes: caller.scopes, clientName: caller.clientName } : null;
    }
    const user = await input.auth.userForApiToken(token);
    return user ? { user } : null;
  }

  function serverFor(principal: Principal): McpServer {
    const { user } = principal;
    let server: McpServer | undefined;
    server = createSitePilotMcpServer({
      backend: input.backend,
      version: input.version,
      caller: () => {
        // An OAuth client is named by its registration, not its handshake.
        const clientName = principal.clientName ?? server?.server.getClientVersion()?.name;
        return {
          ...(clientName !== undefined ? { clientName } : {}),
          ...(principal.scopes !== undefined ? { scopes: principal.scopes } : {}),
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

  function unauthorized(response: ServerResponse, hadToken: boolean): void {
    const parts = [
      'Bearer realm="sitepilot"',
      ...(hadToken ? ['error="invalid_token"'] : []),
      ...(input.resourceMetadataUrl ? [`resource_metadata="${input.resourceMetadataUrl}"`] : [])
    ];
    response.setHeader("www-authenticate", parts.join(", "));
    rpcError(
      response,
      401,
      hadToken
        ? "That SitePilot token is unknown, revoked or expired. Sign in again."
        : "Sign in to SitePilot to connect, or use a personal token from your SitePilot account page."
    );
  }

  return async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const token = bearer(request);
    const principal = token ? await principalFor(token) : null;
    if (!token || !principal) {
      unauthorized(response, request.headers.authorization !== undefined);
      return;
    }
    if (overLimit(principal.user.userProfileId)) {
      response.setHeader("retry-after", String(Math.ceil(RATE_WINDOW_MS / 1000)));
      rpcError(response, 429, "Too many SitePilot requests. Wait a minute and try again.");
      return;
    }
    const owner = JSON.stringify([
      principal.user.userProfileId,
      principal.scopes ?? null,
      principal.clientName ?? null
    ]);
    const header = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    // A session only ever serves the person, scopes and client that opened it.
    if (existing && existing.owner !== owner) {
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
      const server = serverFor(principal);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, owner, lastUsedAt: Date.now() });
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
