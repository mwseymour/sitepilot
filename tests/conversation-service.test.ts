import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  repositories: {
    sites: {
      getById: vi.fn(async () => ({ id: "site-1", workspaceId: "workspace-1" }))
    },
    chatMessages: {
      listByThreadId: vi.fn(async () => [])
    }
  }
};

const secrets: Record<string, string | undefined> = {};
const callTool = vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>();
const complete = vi.fn<(messages: unknown[], model: string) => Promise<{ text: string }>>();

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => db
}));

vi.mock("../apps/desktop/src/main/app-secure-storage.js", () => ({
  getSecureStorage: () => ({
    get: async ({ keyId }: { keyId: string }) => secrets[keyId]
  })
}));

vi.mock("../apps/desktop/src/main/planner-preferences-service.js", () => ({
  loadPlannerPreferences: async () => ({
    preferredProvider: "anthropic",
    openaiModel: "gpt-test",
    anthropicModel: "claude-test"
  })
}));

vi.mock("../apps/desktop/src/main/site-mcp-client.js", () => ({
  createMcpClientForSite: async () => ({ ok: true, client: { callTool } })
}));

vi.mock("@sitepilot/provider-adapters", () => ({
  createAnthropicChatClient: () => ({
    providerId: "anthropic",
    complete: async (messages: unknown[], model: string) => ({
      ...(await complete(messages, model)),
      usage: { inputTokens: 0, outputTokens: 0 }
    })
  }),
  createOpenAiChatClient: () => {
    throw new Error("OpenAI should not be used in these tests");
  }
}));

function structured(result: Record<string, unknown>) {
  return { structuredContent: result };
}

const latestPost = {
  post_id: 42,
  post_type: "post",
  post_status: "draft",
  post_title: "Back button hijacking is now an SEO risk",
  post_name: "back-button-hijacking",
  post_date_gmt: "2026-09-25 11:00:00",
  modified_gmt: "2026-09-25 11:30:00",
  permalink: "https://example.test/?p=42"
};

async function reply(text: string) {
  const { buildConversationReply } = await import(
    "../apps/desktop/src/main/conversation-service.js"
  );
  return buildConversationReply({
    siteId: "site-1" as never,
    threadId: "thread-1" as never,
    text
  });
}

describe("conversation service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(secrets)) {
      delete secrets[key];
    }
  });

  describe("without a model provider", () => {
    it("answers the id of the last created post", async () => {
      callTool.mockResolvedValue(
        structured({ ok: true, total_matches: 7, truncated: true, matches: [latestPost] })
      );

      const result = await reply("What is the id of the last post created?");

      expect(callTool).toHaveBeenCalledWith("sitepilot-find-posts", {
        post_type: "post",
        status: "any",
        orderby: "date",
        order: "DESC",
        limit: 1
      });
      expect(result.text).toContain("#42");
    });

    it("asks for random ordering when listing random posts", async () => {
      callTool.mockResolvedValue(
        structured({ ok: true, total_matches: 1, truncated: false, matches: [latestPost] })
      );

      await reply("List me 5 random post ids and titles");

      expect(callTool).toHaveBeenCalledWith(
        "sitepilot-find-posts",
        expect.objectContaining({ orderby: "rand", limit: 5 })
      );
    });

    it("answers only the id when asked for a post id by title", async () => {
      callTool.mockResolvedValue(
        structured({ ok: true, ...latestPost, post_content: "<p>Long body</p>" })
      );

      const result = await reply(
        "Give me the id of the post called 'Back button hijacking is now an SEO risk'"
      );

      expect(callTool).toHaveBeenCalledWith(
        "sitepilot-get-post",
        expect.objectContaining({ title: "Back button hijacking is now an SEO risk" })
      );
      expect(result.text).toContain("42");
      expect(result.text).not.toContain("Long body");
    });

    it("surfaces tool errors instead of reporting no matches", async () => {
      callTool.mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "Invalid parameter(s): orderby" }]
      });

      const result = await reply("List the latest 3 posts");

      expect(result.text).not.toBe("No matching posts found.");
      expect(result.text).toContain("Invalid parameter");
    });

    it("retries without sorting when the site plugin rejects it", async () => {
      callTool
        .mockResolvedValueOnce({
          isError: true,
          content: [{ type: "text", text: "Invalid parameter(s): orderby" }]
        })
        .mockResolvedValueOnce(
          structured({ ok: true, total_matches: 1, truncated: false, matches: [latestPost] })
        );

      const result = await reply("List the latest 3 posts");

      expect(callTool).toHaveBeenLastCalledWith("sitepilot-find-posts", {
        post_type: "post",
        status: "any",
        limit: 3
      });
      expect(result.text).toContain("#42");
      expect(result.text).toContain("does not support sorting");
    });
  });

  describe("with a model provider", () => {
    beforeEach(() => {
      secrets.anthropic = "test-key";
    });

    it("feeds tool results back to the model and returns its answer", async () => {
      complete
        .mockResolvedValueOnce({
          text: JSON.stringify({
            action: "tool",
            tool: "sitepilot-find-posts",
            arguments: { orderby: "created", order: "desc", limit: 1, bogus: true }
          })
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            action: "reply",
            reply: "The last post created is #42."
          })
        });
      callTool.mockResolvedValue(
        structured({ ok: true, total_matches: 7, truncated: true, matches: [latestPost] })
      );

      const result = await reply("What is the id of the last post created?");

      expect(callTool).toHaveBeenCalledWith("sitepilot-find-posts", {
        limit: 1,
        orderby: "date",
        order: "DESC"
      });
      const secondCallMessages = complete.mock.calls[1]?.[0] as Array<{
        content: string;
      }>;
      expect(secondCallMessages.at(-1)?.content).toContain('"post_id":42');
      expect(result.text).toBe("The last post created is #42.");
    });

    it("falls back to the deterministic lookup when the model output is unusable", async () => {
      complete.mockResolvedValue({ text: "{not json" });
      callTool.mockResolvedValue(
        structured({ ok: true, total_matches: 7, truncated: true, matches: [latestPost] })
      );

      const result = await reply("What is the id of the last post created?");

      expect(result.text).toContain("#42");
    });
  });
});
