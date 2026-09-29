export type McpClientSource = "slack" | "claude" | "codex" | "mcp_other";

/**
 * The SitePilot source for an MCP client, from its self-reported
 * `clientInfo.name`. Good enough for labelling threads on a single-user
 * desktop; the hosted server takes the source from the OAuth client instead.
 */
export function clientSourceFromName(
  name: string | undefined
): McpClientSource {
  const value = (name ?? "").toLowerCase();
  if (value.includes("slack")) return "slack";
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude";
  return "mcp_other";
}
