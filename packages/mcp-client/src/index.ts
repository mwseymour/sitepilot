export const MCP_CLIENT_PACKAGE_NAME = "@sitepilot/mcp-client";

export { McpHttpClient } from "./http-client.js";
export type { McpHttpClientOptions } from "./http-client.js";
export { normalizeMcpToolResult } from "./tool-result.js";
export type {
  JsonRpcError,
  JsonRpcFailure,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  McpToolDefinition,
  ToolsListResult
} from "./types.js";
