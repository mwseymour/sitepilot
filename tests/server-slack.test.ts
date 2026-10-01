import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "../apps/server/src/slack.js";

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
