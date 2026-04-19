/**
 * Minimal JSON-RPC 2.0 shapes used with MCP-over-HTTP (WordPress adapter).
 */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
};

export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export type McpToolDefinition = {
  name: string;
  description?: string;
  /** JSON Schema for tool arguments when provided by the server. */
  inputSchema?: Record<string, unknown>;
};

export type ToolsListResult = {
  tools: McpToolDefinition[];
};
