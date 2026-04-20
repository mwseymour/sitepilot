import { describe, expect, it, vi } from "vitest";

import {
  createOpenAiChatClient,
  estimateUsageCostUsd
} from "@sitepilot/provider-adapters";

describe("@sitepilot/provider-adapters (T23)", () => {
  it("estimates non-negative USD cost from token usage", () => {
    const usd = estimateUsageCostUsd("openai", "gpt-4o-mini", {
      inputTokens: 1_000_000,
      outputTokens: 500_000
    });
    expect(usd).toBeGreaterThan(0);
  });

  it("parses an OpenAI chat completion response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"hello":"world"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 7 }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = createOpenAiChatClient("sk-test");
      const result = await client.complete(
        [
          { role: "system", content: "You are a JSON API." },
          { role: "user", content: "{}" }
        ],
        "gpt-4o-mini"
      );

      expect(result.text).toContain("hello");
      expect(result.usage.inputTokens).toBe(3);
      expect(result.usage.outputTokens).toBe(7);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
