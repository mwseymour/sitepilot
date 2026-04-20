import { describe, expect, it } from "vitest";

import { buildPlannerContext } from "@sitepilot/services";

describe("buildPlannerContext", () => {
  it("produces a schema-valid planner payload", () => {
    const ctx = buildPlannerContext({
      siteId: "site-1",
      threadId: "thread-1",
      builtAt: "2026-04-19T12:00:00.000Z",
      siteConfig: null,
      discoverySnapshot: null,
      messages: [],
      targetSummaries: [],
      priorChanges: []
    });

    expect(ctx.siteId).toBe("site-1");
    expect(ctx.threadId).toBe("thread-1");
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.discoverySummary).toBeNull();
  });
});
