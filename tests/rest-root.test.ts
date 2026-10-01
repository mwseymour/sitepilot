import { describe, expect, it } from "vitest";

import {
  knowsSiteRestRoot,
  protocolDiscoveryUrl,
  rememberSiteRestRoot,
  restRootFromProtocol,
  siteRestUrl
} from "@sitepilot/plugin-protocol";

describe("site REST roots", () => {
  it("reaches /protocol through rest_route on any permalink setting", () => {
    expect(protocolDiscoveryUrl("https://example.com/")).toBe(
      "https://example.com/?rest_route=/sitepilot/v1/protocol"
    );
    expect(protocolDiscoveryUrl("https://example.com/blog")).toBe(
      "https://example.com/blog/?rest_route=/sitepilot/v1/protocol"
    );
  });

  it("reads the root from the plugin's rest_url('sitepilot/v2')", () => {
    expect(
      restRootFromProtocol({ v2: { base_route: "https://dev.example.com/index.php/wp-json/sitepilot/v2" } })
    ).toBe("https://dev.example.com/index.php/wp-json/");
    expect(restRootFromProtocol({ v2: { base_route: "https://example.com/wp-json/sitepilot/v2" } })).toBe(
      "https://example.com/wp-json/"
    );
    expect(restRootFromProtocol({ v2: { base_route: "https://plain.example.com/?rest_route=/sitepilot/v2" } })).toBe(
      "https://plain.example.com/?rest_route=/"
    );
    expect(restRootFromProtocol({})).toBeNull();
  });

  it("builds REST URLs from what the site reported, and /wp-json/ until then", () => {
    expect(siteRestUrl("https://unknown.example.com/", "sitepilot/v2/prepare")).toBe(
      "https://unknown.example.com/wp-json/sitepilot/v2/prepare"
    );
    rememberSiteRestRoot("https://dev.example.com/", "https://dev.example.com/index.php/wp-json/");
    expect(knowsSiteRestRoot("https://dev.example.com")).toBe(true);
    expect(siteRestUrl("https://dev.example.com", "/sitepilot/mcp")).toBe(
      "https://dev.example.com/index.php/wp-json/sitepilot/mcp"
    );
  });
});
