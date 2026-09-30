import { describe, expect, it, vi } from "vitest";

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => {
    throw new Error(
      "The approval guard must refuse before touching the database."
    );
  }
}));

import {
  DEFAULT_OPERATOR,
  callerMay,
  currentActor,
  runWithCallContext,
  type CallContext
} from "../apps/desktop/src/main/call-context.js";
import {
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate
} from "../apps/desktop/src/main/gutenberg-v2-chat-service.js";
import type { RequestId, SiteId } from "@sitepilot/domain";

const MCP_CLIENT: CallContext = {
  actor: { ...DEFAULT_OPERATOR, siteRoles: ["request"] },
  source: "claude",
  tool: "create_request"
};

describe("call context", () => {
  it("defaults to the desktop operator, who may do everything", () => {
    expect(currentActor()).toEqual({ ...DEFAULT_OPERATOR, source: "desktop" });
    expect(callerMay("approve")).toBe(true);
  });

  it("tags the actor with the MCP client and withholds approval", async () => {
    await runWithCallContext(MCP_CLIENT, async () => {
      expect(currentActor().source).toBe("claude");
      expect(callerMay("read")).toBe(true);
      expect(callerMay("request")).toBe(true);
      expect(callerMay("approve")).toBe(false);
    });
  });

  it("keeps the context across awaits", async () => {
    await runWithCallContext(MCP_CLIENT, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentActor().source).toBe("claude");
    });
    expect(currentActor().source).toBe("desktop");
  });

  it("refuses approval and execution from an MCP client", async () => {
    await runWithCallContext(MCP_CLIENT, async () => {
      const siteId = "site-1" as SiteId;
      const requestId = "request-1" as RequestId;
      for (const decision of ["approved", "rejected"] as const) {
        const result = await decideGutenbergV2Candidate({
          siteId,
          requestId,
          candidateId: "candidate-1",
          decision
        });
        expect(result).toMatchObject({ ok: false, code: "forbidden" });
      }
      expect(
        await executeGutenbergV2Candidate({ siteId, requestId })
      ).toMatchObject({ ok: false, code: "forbidden" });
    });
  });
});
