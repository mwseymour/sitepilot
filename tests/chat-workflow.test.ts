import { describe, expect, it } from "vitest";

import {
  humanRequestStatus,
  modePageCopy
} from "../apps/desktop/src/renderer/chat-workflow.js";

describe("humanRequestStatus", () => {
  it("maps known request statuses", () => {
    expect(humanRequestStatus("clarifying")).toBe("Waiting for your answer");
    expect(humanRequestStatus("new")).toBe("Ready to build");
    expect(humanRequestStatus("drafted")).toBe("Ready to build");
    expect(humanRequestStatus("awaiting_approval")).toBe("Needs approval");
    expect(humanRequestStatus("approved")).toBe("Ready to apply");
    expect(humanRequestStatus("executing")).toBe("Running on the site");
    expect(humanRequestStatus("completed")).toBe("Done");
    expect(humanRequestStatus("failed")).toBe("Failed");
    expect(humanRequestStatus("cancelled")).toBe("Cancelled");
  });

  it("title-cases unknown statuses", () => {
    expect(humanRequestStatus("awaiting_review")).toBe("Awaiting Review");
  });
});

describe("modePageCopy", () => {
  it("returns request mode copy", () => {
    expect(modePageCopy("request")).toEqual({
      navHint: "Make site changes",
      pageLede:
        "A request builds the change in this site’s WordPress editor for you to review, approve and apply. Use Conversations only when you need to look something up first.",
      emptyState:
        "Create a request and describe the change. You review a preview before anything is saved. Conversations will not change the site.",
      otherModeLabel: "Open Conversations",
      otherModePathSegment: "conversations"
    });
  });

  it("returns conversation mode copy", () => {
    expect(modePageCopy("conversation")).toEqual({
      navHint: "Research only",
      pageLede:
        "Conversations are research-only. They do not generate plans or change the site. Start a Request when you want something applied.",
      emptyState:
        "Start a conversation to look up content or gather source material. When you are ready to change the site, open Requests.",
      otherModeLabel: "Open Requests",
      otherModePathSegment: "chat"
    });
  });
});
