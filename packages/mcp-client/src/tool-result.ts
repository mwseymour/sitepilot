/**
 * Normalizes MCP `tools/call` JSON-RPC `result` payloads (WordPress adapter may
 * return `structuredContent`, `content`, or a plain object).
 */
export function normalizeMcpToolResult(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (
      "structuredContent" in obj &&
      obj["structuredContent"] !== null &&
      typeof obj["structuredContent"] === "object" &&
      !Array.isArray(obj["structuredContent"])
    ) {
      return obj["structuredContent"] as Record<string, unknown>;
    }
    if ("content" in obj && Array.isArray(obj["content"])) {
      const first = obj["content"][0];
      if (
        first &&
        typeof first === "object" &&
        "text" in first &&
        typeof (first as { text?: string }).text === "string"
      ) {
        try {
          const parsed = JSON.parse(
            (first as { text: string }).text
          ) as unknown;
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return { raw: (first as { text: string }).text };
        }
      }
    }
    return obj;
  }
  return { value: raw };
}
