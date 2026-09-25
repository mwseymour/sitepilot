import { describe, expect, it } from "vitest";

import { gutenbergV2StatusIntent } from "../apps/desktop/src/main/gutenberg-v2-status-intent.js";

describe("publish and unpublish follow-ups", () => {
  it.each([
    ["publish it", "publish"],
    ["Publish it now.", "publish"],
    ["please publish this post", "publish"],
    ["publish", "publish"],
    ["make it live", "publish"],
    ["go live with it", "publish"],
    ["unpublish it", "draft"],
    ["Take it down!", "draft"],
    ["take this page offline", "draft"],
    ["revert it to draft", "draft"],
    ["set it back to a draft please", "draft"]
  ])("reads %j as %s", (text, expected) => {
    expect(gutenbergV2StatusIntent(text)).toBe(expected);
  });

  it.each([
    "publish a new post about cats",
    "make it blue",
    "make it",
    "publish the post about dogs tomorrow",
    "unpublish post 946",
    "can you add a heading and then publish it"
  ])("leaves %j as a content request", (text) => {
    expect(gutenbergV2StatusIntent(text)).toBeNull();
  });
});
