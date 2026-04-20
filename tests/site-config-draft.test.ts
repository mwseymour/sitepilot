import { describe, expect, it } from "vitest";

import { siteConfigSchema } from "@sitepilot/contracts";
import type { DiscoverySnapshot } from "@sitepilot/domain";

import { buildSiteConfigDraftFromDiscovery } from "../apps/desktop/src/main/site-config-draft.js";

const baseSnapshot = (
  summary: Record<string, unknown>,
  overrides: Partial<DiscoverySnapshot> = {}
): DiscoverySnapshot => ({
  id: "discovery-snap-1",
  siteId: "site-1",
  revision: 2,
  warnings: ["Example warning from WordPress."],
  capabilities: ["sitepilot-site-discovery", "sitepilot-ping"],
  summary,
  createdAt: "2026-04-19T10:00:00.000Z",
  updatedAt: "2026-04-19T10:00:00.000Z",
  ...overrides
});

describe("buildSiteConfigDraftFromDiscovery", () => {
  it("maps WordPress discovery payload into a schema-valid SiteConfig draft", () => {
    const discoveryPayload = {
      wordpress: { version: "6.9", language: "en_US", timezone: "UTC" },
      site: {
        name: "Acme Blog",
        tagline: "Just another WordPress site",
        home_url: "https://acme.test/"
      },
      theme: {
        name: "Twenty Twenty-Five",
        version: "1.0",
        slug: "twentytwentyfive"
      },
      post_types: {
        post: { label: "Posts", public: true },
        page: { label: "Pages", public: true },
        attachment: { label: "Media", public: true }
      },
      taxonomies: {
        category: { label: "Categories" },
        post_tag: { label: "Tags" }
      },
      nav_menus: [
        { id: 1, name: "Primary", slug: "primary" },
        { id: 2, name: "Footer", slug: "footer" }
      ],
      active_plugins: ["wordpress-seo/wp-seo.php"],
      seo: { yoast_seo: true },
      warnings: []
    };

    const snapshot = baseSnapshot({ discovery: discoveryPayload });

    const draft = buildSiteConfigDraftFromDiscovery({
      id: "config-draft-1",
      siteId: "site-1",
      version: 1,
      siteName: "Fallback Name",
      siteBaseUrl: "https://fallback.test/",
      discoverySnapshot: snapshot,
      now: "2026-04-19T12:00:00.000Z"
    });

    expect(() => siteConfigSchema.parse(draft)).not.toThrow();
    expect(draft.activationStatus).toBe("config_required");
    expect(draft.requiredSectionsComplete).toBe(false);
    expect(draft.metadata.generatedFromDiscoverySnapshotId).toBe(
      "discovery-snap-1"
    );
    expect(draft.sections.identity.siteName).toBe("Acme Blog");
    expect(draft.sections.identity.baseUrl).toBe("https://acme.test/");
    expect(draft.sections.structure.publicSections).toEqual([
      "Primary",
      "Footer"
    ]);
    expect(draft.sections.contentModel.editablePostTypes).toEqual([
      "post",
      "page"
    ]);
    expect(draft.sections.contentModel.readOnlyPostTypes).toContain(
      "attachment"
    );
    expect(draft.sections.seoPolicy.titlePatterns[0]).toContain("%%");
    expect(draft.sections.toolAccessPolicy.enabledTools).toEqual([
      "sitepilot-site-discovery",
      "sitepilot-ping"
    ]);
    expect(
      draft.metadata.notes.some((n) => n.includes("Example warning"))
    ).toBe(true);
  });

  it("falls back to site metadata when discovery payload is empty", () => {
    const snapshot = baseSnapshot({ discovery: {} });

    const draft = buildSiteConfigDraftFromDiscovery({
      id: "config-draft-2",
      siteId: "site-2",
      version: 1,
      siteName: "Local Site",
      siteBaseUrl: "https://local.test/",
      discoverySnapshot: snapshot,
      now: "2026-04-19T12:00:00.000Z"
    });

    expect(draft.sections.identity.siteName).toBe("Local Site");
    expect(draft.sections.identity.baseUrl).toBe("https://local.test/");
    expect(draft.sections.structure.publicSections.length).toBeGreaterThan(0);
  });
});
