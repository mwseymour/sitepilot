import { describe, expect, it } from "vitest";

import { McpHttpClient } from "@sitepilot/mcp-client";

describe("McpHttpClient", () => {
  it("initializes a session then lists tools with Mcp-Session-Id", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
      };
      if (calls === 1) {
        expect(body.method).toBe("initialize");
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "test", version: "1" },
              capabilities: {}
            }
          }),
          {
            status: 200,
            headers: { "Mcp-Session-Id": "test-session" }
          }
        );
      }
      expect(body.method).toBe("tools/list");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Mcp-Session-Id"] ?? headers["mcp-session-id"]).toBe(
        "test-session"
      );
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              {
                name: "sitepilot/ping",
                description: "Ping",
                inputSchema: { type: "object" }
              }
            ]
          }
        }),
        { status: 200 }
      );
    };

    const client = new McpHttpClient({
      endpointUrl: "https://example.test/wp-json/sitepilot/mcp",
      fetchFn
    });

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]?.name).toBe("sitepilot/ping");

    const schemas = await client.loadToolSchemas();
    expect(schemas["sitepilot/ping"]?.name).toBe("sitepilot/ping");
  });
});
