import { describe, expect, it } from "vitest";

import { normalizeMcpToolResult } from "@sitepilot/mcp-client";

describe("normalizeMcpToolResult", () => {
  it("prefers structuredContent from MCP tool results", () => {
    const out = normalizeMcpToolResult({
      structuredContent: { wordpress: { version: "6.9" }, site: { name: "T" } },
      content: []
    });
    expect(out.wordpress).toEqual({ version: "6.9" });
  });

  it("parses JSON from text content when structuredContent is absent", () => {
    const out = normalizeMcpToolResult({
      content: [{ type: "text", text: '{"a":1}' }]
    });
    expect(out).toEqual({ a: 1 });
  });
});
