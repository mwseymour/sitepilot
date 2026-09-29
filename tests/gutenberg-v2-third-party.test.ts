import { describe, expect, it } from "vitest";

import {
  buildGutenbergV2ThirdPartyReport,
  gutenbergV2BlockUsageSchema,
  gutenbergV2ThirdPartyProbeSchema,
  type GutenbergV2ThirdPartyProbeBlock
} from "@sitepilot/contracts";

function block(
  name: string,
  placement: GutenbergV2ThirdPartyProbeBlock["placement"],
  outcome: GutenbergV2ThirdPartyProbeBlock["probe"]["outcome"] = "builds_cleanly"
): GutenbergV2ThirdPartyProbeBlock {
  return {
    name,
    title: name,
    placement,
    parents: placement === "inside_block" ? ["vendor/parent"] : [],
    rendering: "saved_markup",
    hasExample: false,
    variations: 0,
    deprecations: 0,
    settings: [{ name: "items", type: "array" }],
    probe: {
      outcome: placement === "top_level" ? outcome : "not_tested",
      preview: "not_checked"
    }
  };
}

const probe = gutenbergV2ThirdPartyProbeSchema.parse({
  schemaVersion: "sitepilot.third-party-probe/v2",
  timedOut: false,
  blocks: [
    block("vendor/child", "inside_block"),
    block("vendor/hidden", "hidden"),
    block("vendor/broken", "top_level", "invalid"),
    block("vendor/rare", "top_level"),
    block("vendor/popular", "top_level"),
    block("vendor/settles", "top_level", "changes_when_edited")
  ]
});

const usage = gutenbergV2BlockUsageSchema.parse({
  schemaVersion: "sitepilot.block-usage/v2",
  scannedPosts: 12,
  truncated: false,
  blocks: [
    {
      name: "vendor/popular",
      posts: 5,
      uses: 9,
      examples: [{ postId: 3, attributes: '{"items":[]}' }]
    },
    { name: "vendor/child", posts: 2, uses: 2, examples: [] },
    { name: "vendor/uninstalled", posts: 7, uses: 7, examples: [] }
  ]
});

describe("third-party block report", () => {
  it("lists blocks worth supporting first, most used first", () => {
    const report = buildGutenbergV2ThirdPartyReport(probe, usage);
    expect(report.blocks.map((entry) => [entry.name, entry.readiness])).toEqual([
      ["vendor/popular", "needs_definition"],
      ["vendor/rare", "needs_definition"],
      ["vendor/settles", "needs_definition"],
      ["vendor/broken", "needs_attention"],
      ["vendor/child", "inside_block"],
      ["vendor/hidden", "hidden"]
    ]);
  });

  it("joins usage by block name and drops blocks no longer registered", () => {
    const report = buildGutenbergV2ThirdPartyReport(probe, usage);
    const byName = new Map(report.blocks.map((entry) => [entry.name, entry]));
    expect(byName.get("vendor/popular")!.usage).toEqual({
      posts: 5,
      uses: 9,
      examples: [{ postId: 3, attributes: '{"items":[]}' }]
    });
    expect(byName.get("vendor/rare")!.usage).toEqual({
      posts: 0,
      uses: 0,
      examples: []
    });
    expect(byName.has("vendor/uninstalled")).toBe(false);
    expect(report).toMatchObject({
      scannedPosts: 12,
      usageTruncated: false,
      probeTimedOut: false
    });
  });
});
