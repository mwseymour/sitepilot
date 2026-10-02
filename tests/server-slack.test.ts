import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "../apps/server/src/slack.js";
import { routeChoice, routeSlackMessage } from "../apps/server/src/slack-routing.js";

/** Slack signs every request: SitePilot acts only on ones that check out. */
describe("Slack request signatures", () => {
  const signingSecret = "slack-signing-secret-for-tests";
  const now = 1_790_000_000;
  const body = '{"type":"event_callback"}';
  const sign = (timestamp: number, text = body, secret = signingSecret) =>
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${text}`).digest("hex")}`;

  it("accepts a current request signed with the app's secret", () => {
    expect(verifySlackSignature({ body, timestamp: String(now), signature: sign(now), signingSecret, nowSeconds: now + 10 })).toBe(true);
  });

  it("refuses another secret, a changed body, an old request or no signature", () => {
    expect(
      verifySlackSignature({ body, timestamp: String(now), signature: sign(now, body, "someone else"), signingSecret, nowSeconds: now })
    ).toBe(false);
    expect(
      verifySlackSignature({ body: '{"type":"other"}', timestamp: String(now), signature: sign(now), signingSecret, nowSeconds: now })
    ).toBe(false);
    expect(
      verifySlackSignature({ body, timestamp: String(now), signature: sign(now), signingSecret, nowSeconds: now + 6 * 60 })
    ).toBe(false);
    expect(verifySlackSignature({ body, timestamp: undefined, signature: undefined, signingSecret, nowSeconds: now })).toBe(false);
  });
});

/** A question gets an answer, a change becomes a request, and SitePilot asks when it can't tell. */
describe("Slack message routing", () => {
  const kind = (text: string, hasAttachments = false) => routeSlackMessage(text, { hasAttachments }).kind;

  it("answers questions and lookups", () => {
    for (const text of [
      "what is the last post I created?",
      "Which posts are tagged Lakes?",
      "how many pages are there",
      "can you list the drafts?",
      "Show me post 102",
      "what's the meta description on post 946?",
      "is there a post about opening hours?"
    ]) {
      expect(kind(text), text).toBe("conversation");
    }
  });

  it("makes requests for changes", () => {
    for (const text of [
      "Write a post about our spring pricing",
      "tag post 102 with Lakes",
      "Please add a paragraph about parking to post 5",
      "Could you publish it?",
      "Make that image the featured image",
      "Create a short draft post titled \"Hello\""
    ]) {
      expect(kind(text), text).toBe("request");
    }
    // Images on a message are for a change.
    expect(kind("this one", true)).toBe("request");
  });

  it("asks when the wording doesn't say", () => {
    for (const text of ["how do I add a tag?", "the intro on post 5 is too long", "show me post 5 and update its title", "hello"]) {
      expect(kind(text), text).toBe("unsure");
    }
  });

  it("lets the person say which", () => {
    expect(routeSlackMessage("ask how do I add a tag?")).toEqual({ kind: "conversation", text: "how do I add a tag?", forced: true });
    expect(routeSlackMessage("change: the intro is too long")).toEqual({ kind: "request", text: "the intro is too long", forced: true });
    // A change that starts with "change" keeps its words.
    expect(routeSlackMessage("change the title of post 5 to Hello")).toEqual({
      kind: "request",
      text: "change the title of post 5 to Hello",
      forced: false
    });
    expect(kind("question 5 in the FAQ is wrong")).toBe("unsure");
    expect(routeChoice("Ask")).toBe("conversation");
    expect(routeChoice("a change.")).toBe("request");
    expect(routeChoice("what about post 5?")).toBeNull();
  });
});
