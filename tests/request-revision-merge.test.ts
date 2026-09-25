import { describe, expect, it, vi } from "vitest";

import {
  fallbackMergedRequestPrompt,
  mergeRevisedRequestPrompt
} from "../packages/services/src/request-revision-merge.js";

describe("fallbackMergedRequestPrompt", () => {
  it("keeps the original request and does not replace it with only the follow-up", () => {
    const merged = fallbackMergedRequestPrompt(
      "Create a post with 2 carrots.",
      "Also add 1 plum."
    );
    expect(merged).toContain("2 carrots");
    expect(merged).toContain("1 plum");
    expect(merged).not.toBe("Also add 1 plum.");
  });
});

describe("mergeRevisedRequestPrompt", () => {
  it("uses the model to add items onto the current request", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        updatedRequest: "Create a post with 2 carrots and 1 plum."
      }),
      usage: { inputTokens: 8, outputTokens: 12 }
    }));

    const merged = await mergeRevisedRequestPrompt({
      currentPrompt: "Create a post with 2 carrots.",
      followUp: "Also add 1 plum.",
      client: { providerId: "openai", complete },
      model: "test-model"
    });

    expect(merged).toBe("Create a post with 2 carrots and 1 plum.");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("uses the model to reduce quantities instead of appending a minus instruction", async () => {
    const merged = await mergeRevisedRequestPrompt({
      currentPrompt: "Create a post with 2 carrots and 1 plum.",
      followUp: "Actually take one carrot away.",
      client: {
        providerId: "openai",
        complete: async () => ({
          text: JSON.stringify({
            updatedRequest: "Create a post with 1 carrot and 1 plum."
          }),
          usage: { inputTokens: 8, outputTokens: 12 }
        })
      },
      model: "test-model"
    });

    expect(merged).toBe("Create a post with 1 carrot and 1 plum.");
    expect(merged.toLowerCase()).not.toMatch(/minus|take one carrot away/);
  });

  it("falls back without a model client", async () => {
    const merged = await mergeRevisedRequestPrompt({
      currentPrompt: "Create a post with 2 carrots.",
      followUp: "Also add 1 plum."
    });
    expect(merged).toBe(
      fallbackMergedRequestPrompt(
        "Create a post with 2 carrots.",
        "Also add 1 plum."
      )
    );
  });
});
