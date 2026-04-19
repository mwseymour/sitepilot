import { z } from "zod";

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  McpToolDefinition,
  ToolsListResult
} from "./types.js";

const toolsListResultSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).optional()
    })
  )
});

export type McpHttpClientOptions = {
  /** Full MCP HTTP endpoint URL (e.g. https://site/wp-json/sitepilot/mcp). */
  endpointUrl: string;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
};

const DEFAULT_CLIENT_INFO = {
  name: "@sitepilot/mcp-client",
  version: "0.1.0"
} as const;

/**
 * HTTP JSON-RPC client for WordPress MCP Streamable HTTP transports.
 * The WordPress adapter issues an `Mcp-Session-Id` header after `initialize`;
 * subsequent JSON-RPC calls must include that header.
 */
export class McpHttpClient {
  private readonly endpointUrl: string;
  private readonly fetchFn: typeof fetch;
  private baseHeaders: Record<string, string>;
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(options: McpHttpClientOptions) {
    this.endpointUrl = options.endpointUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers
    };
  }

  private buildRequest(method: string, params?: unknown): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params: params ?? {}
    };
  }

  /**
   * Performs MCP `initialize` and stores `Mcp-Session-Id` from the response headers.
   */
  async connect(
    params: {
      protocolVersion?: string;
      clientInfo?: { name: string; version: string };
    } = {}
  ): Promise<unknown> {
    const body = this.buildRequest("initialize", {
      protocolVersion: params.protocolVersion ?? "2025-06-18",
      clientInfo: params.clientInfo ?? DEFAULT_CLIENT_INFO
    });

    const response = await this.fetchFn(this.endpointUrl, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body)
    });

    const session =
      response.headers.get("mcp-session-id") ??
      response.headers.get("Mcp-Session-Id");
    if (session) {
      this.sessionId = session;
    }

    const text = await response.text();
    const parsed = JSON.parse(text) as JsonRpcResponse<unknown>;

    if (!response.ok) {
      throw new Error(`MCP HTTP: ${response.status} — ${text}`);
    }

    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = (parsed as { error: { code: number; message: string } }).error;
      throw new Error(`MCP HTTP JSON-RPC error ${err.code}: ${err.message}`);
    }

    if (!this.sessionId) {
      throw new Error(
        "MCP HTTP: missing Mcp-Session-Id header after initialize (session required for tools/list)"
      );
    }

    if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
      return (parsed as JsonRpcSuccess<unknown>).result;
    }

    throw new Error("MCP HTTP: invalid initialize response");
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) {
      return;
    }
    await this.connect();
  }

  private requestHeaders(): Record<string, string> {
    if (!this.sessionId) {
      return this.baseHeaders;
    }
    return { ...this.baseHeaders, "Mcp-Session-Id": this.sessionId };
  }

  private async postRpc<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureSession();

    const body = this.buildRequest(method, params);
    const response = await this.fetchFn(this.endpointUrl, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`MCP HTTP: invalid JSON (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(
        `MCP HTTP: ${response.status} ${response.statusText} — ${text}`
      );
    }

    const envelope = parsed as JsonRpcResponse<T>;
    if (typeof envelope !== "object" || envelope === null) {
      throw new Error("MCP HTTP: empty response");
    }
    if ("error" in envelope && envelope.error) {
      const err = envelope.error;
      throw new Error(`MCP HTTP JSON-RPC error ${err.code}: ${err.message}`);
    }
    if (!("result" in envelope)) {
      throw new Error("MCP HTTP: missing result field");
    }
    return (envelope as JsonRpcSuccess<T>).result;
  }

  async initialize(params: {
    protocolVersion: string;
    clientInfo: { name: string; version: string };
  }): Promise<unknown> {
    return this.connect(params);
  }

  async listTools(): Promise<ToolsListResult> {
    const raw = await this.postRpc<unknown>("tools/list", {});
    return toolsListResultSchema.parse(raw);
  }

  /**
   * Returns parsed tool definitions keyed by tool name for quick lookups.
   */
  async loadToolSchemas(): Promise<Record<string, McpToolDefinition>> {
    const { tools } = await this.listTools();
    const map: Record<string, McpToolDefinition> = {};
    for (const tool of tools) {
      map[tool.name] = tool;
    }
    return map;
  }

  async callTool(
    name: string,
    argumentsJson: Record<string, unknown>
  ): Promise<unknown> {
    return this.postRpc("tools/call", {
      name,
      arguments: argumentsJson
    });
  }
}
