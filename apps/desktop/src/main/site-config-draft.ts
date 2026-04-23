import { randomUUID } from "node:crypto";

import { siteConfigSchema, type SiteConfig } from "@sitepilot/contracts";
import type {
  DiscoverySnapshot,
  JsonObject,
  SiteConfigId,
  SiteConfigVersion,
  SiteId
} from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

type PostTypeMap = Record<string, { label?: string; public?: boolean }>;
type TaxonomyMap = Record<string, { label?: string }>;
type NavMenu = { id?: number; name?: string; slug?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getDiscoveryPayload(
  summary: JsonObject
): Record<string, unknown> | null {
  const raw = summary["discovery"];
  return asRecord(raw);
}

function stringField(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parsePostTypes(d: Record<string, unknown>): PostTypeMap {
  const raw = d["post_types"];
  const rec = asRecord(raw);
  if (!rec) {
    return {};
  }
  const out: PostTypeMap = {};
  for (const [slug, val] of Object.entries(rec)) {
    if (typeof slug !== "string" || slug.length === 0) {
      continue;
    }
    const o = asRecord(val);
    const entry: { label?: string; public?: boolean } = {};
    if (o) {
      const label = stringField(o, "label");
      if (label !== undefined) {
        entry.label = label;
      }
      if (typeof o["public"] === "boolean") {
        entry.public = o["public"];
      }
    }
    out[slug] = entry;
  }
  return out;
}

function parseTaxonomies(d: Record<string, unknown>): TaxonomyMap {
  const raw = d["taxonomies"];
  const rec = asRecord(raw);
  if (!rec) {
    return {};
  }
  const out: TaxonomyMap = {};
  for (const [slug, val] of Object.entries(rec)) {
    if (typeof slug !== "string" || slug.length === 0) {
      continue;
    }
    const o = asRecord(val);
    const entry: { label?: string } = {};
    if (o) {
      const label = stringField(o, "label");
      if (label !== undefined) {
        entry.label = label;
      }
    }
    out[slug] = entry;
  }
  return out;
}

function parseNavMenus(d: Record<string, unknown>): NavMenu[] {
  const raw = d["nav_menus"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: NavMenu[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) {
      continue;
    }
    const entry: NavMenu = {};
    if (typeof o["id"] === "number") {
      entry.id = o["id"];
    }
    const name = stringField(o, "name");
    if (name !== undefined) {
      entry.name = name;
    }
    const slug = stringField(o, "slug");
    if (slug !== undefined) {
      entry.slug = slug;
    }
    out.push(entry);
  }
  return out;
}

function parseSeoHints(d: Record<string, unknown>): { yoast?: boolean } {
  const raw = d["seo"];
  const o = asRecord(raw);
  if (!o) {
    return {};
  }
  return { yoast: o["yoast_seo"] === true };
}

function parseThirdPartyBlocks(d: Record<string, unknown>): string[] {
  const raw = d["third_party_blocks"];
  if (!Array.isArray(raw)) {
    return [];
  }

  const names = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) {
      names.add(item);
      continue;
    }

    const obj = asRecord(item);
    if (!obj) {
      continue;
    }

    const name = stringField(obj, "name");
    if (name !== undefined) {
      names.add(name);
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

const READ_ONLY_POST_TYPES = new Set([
  "attachment",
  "revision",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_navigation",
  "wp_global_styles"
]);

export type BuildSiteConfigDraftParams = {
  id: SiteConfig["id"];
  siteId: SiteConfig["siteId"];
  version: number;
  siteName: string;
  siteBaseUrl: string;
  discoverySnapshot: DiscoverySnapshot;
  now: string;
};

/**
 * Deterministic first-pass `SiteConfig` from a persisted discovery snapshot and site metadata.
 * Intended as a draft until the operator confirms (activation gating).
 */
export function buildSiteConfigDraftFromDiscovery(
  params: BuildSiteConfigDraftParams
): SiteConfig {
  const { id, siteId, version, siteName, siteBaseUrl, discoverySnapshot, now } =
    params;
  const d = getDiscoveryPayload(discoverySnapshot.summary) ?? {};
  const siteBlock = asRecord(d["site"]);
  const themeBlock = asRecord(d["theme"]);
  const wpBlock = asRecord(d["wordpress"]);

  const discoveredName =
    (siteBlock && stringField(siteBlock, "name")) ?? siteName;
  const discoveredHome =
    (siteBlock && stringField(siteBlock, "home_url")) ?? siteBaseUrl;
  const tagline = siteBlock ? stringField(siteBlock, "tagline") : undefined;
  const themeName = themeBlock ? stringField(themeBlock, "name") : undefined;
  const themeSlug = themeBlock ? stringField(themeBlock, "slug") : undefined;
  const wpVersion = wpBlock ? stringField(wpBlock, "version") : undefined;

  const postTypes = parsePostTypes(d);
  const taxonomies = parseTaxonomies(d);
  const navMenus = parseNavMenus(d);
  const seo = parseSeoHints(d);
  const thirdPartyBlocks = parseThirdPartyBlocks(d);

  const editablePostTypes = Object.keys(postTypes).filter(
    (slug) => !READ_ONLY_POST_TYPES.has(slug)
  );
  const readOnlyPostTypes = Object.keys(postTypes).filter((slug) =>
    READ_ONLY_POST_TYPES.has(slug)
  );

  const menuSectionNames = navMenus
    .map((m) => m.name?.trim())
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  const publicSections =
    menuSectionNames.length > 0
      ? menuSectionNames
      : ["Primary navigation (confirm menu structure)"];

  const pageTreeSummary =
    menuSectionNames.length > 0
      ? `Navigation menus detected: ${menuSectionNames.join(", ")}. Confirm page hierarchy against the live site.`
      : "Discovery did not enumerate menus or page hierarchy. Map primary sections manually.";

  const taxonomyDefinitions = Object.entries(taxonomies).map(([slug, t]) => {
    const label = t.label?.trim() ?? slug;
    return `${slug} (${label})`;
  });

  const businessParts = [
    `${discoveredName} (${discoveredHome}).`,
    tagline ? `Tagline: ${tagline}` : undefined,
    themeName
      ? `Active theme: ${themeName}${themeSlug ? ` (${themeSlug})` : ""}.`
      : undefined,
    wpVersion ? `WordPress ${wpVersion}.` : undefined
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  const businessDescription =
    businessParts.join(" ") ||
    `${discoveredName} is connected to SitePilot; replace this description with your positioning.`;

  const audienceSummary = `People visiting ${discoveredName} and using content surfaced from public post types and navigation.`;

  const titlePatterns = seo.yoast
    ? ["%%title%% %%sep%% %%sitename%%", "{title} | {siteName}"]
    : ["{title} | {siteName}", "{title} — {siteName}"];

  const featuredImagePostTypes = ["post"].filter((slug) => slug in postTypes);

  const toolNames = discoverySnapshot.capabilities.filter(
    (n) => typeof n === "string" && n.length > 0
  );

  const notes: string[] = [
    "Draft generated from discovery snapshot; review all sections before activation."
  ];
  if (discoverySnapshot.warnings.length > 0) {
    notes.push(...discoverySnapshot.warnings);
  }

  const draft: SiteConfig = {
    id,
    siteId,
    version,
    requiredSectionsComplete: false,
    activationStatus: "config_required",
    sections: {
      identity: {
        siteName: discoveredName,
        baseUrl: discoveredHome,
        businessDescription,
        audienceSummary
      },
      structure: {
        publicSections,
        restrictedTemplates: [],
        pageTreeSummary
      },
      contentModel: {
        editablePostTypes:
          editablePostTypes.length > 0 ? editablePostTypes : ["post", "page"],
        readOnlyPostTypes:
          readOnlyPostTypes.length > 0 ? readOnlyPostTypes : ["attachment"],
        taxonomyDefinitions:
          taxonomyDefinitions.length > 0
            ? taxonomyDefinitions
            : ["category (Category)", "post_tag (Tag)"],
        thirdPartyBlocks
      },
      seoPolicy: {
        titlePatterns,
        redirectsRequireApproval: true,
        internalLinkingExpectation:
          "Prefer contextual internal links between related posts and pages; avoid orphan content where possible."
      },
      mediaPolicy: {
        acceptedFormats: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/svg+xml"
        ],
        altTextRequired: true,
        featuredImageRequiredPostTypes:
          featuredImagePostTypes.length > 0 ? featuredImagePostTypes : ["post"]
      },
      approvalPolicy: {
        autoApproveCategories: [],
        publishRequiresApproval: true,
        menuChangesRequireApproval: true
      },
      toolAccessPolicy: {
        enabledTools:
          toolNames.length > 0 ? toolNames : ["sitepilot-site-discovery"],
        disabledTools: [],
        dryRunOnlyTools: []
      },
      contentStylePolicy: {
        tone: "Clear and professional, consistent with the site brand.",
        readingLevel: "General audience",
        disallowedWording: []
      },
      guardrails: {
        neverEditPages: [],
        neverModifyMenuAutomatically: true,
        neverPublishWithoutApproval: true
      }
    },
    metadata: {
      generatedFromDiscoverySnapshotId: discoverySnapshot.id,
      notes
    },
    createdAt: now,
    updatedAt: now
  };

  return siteConfigSchema.parse(draft);
}

export type GenerateSiteConfigDraftResult =
  | { ok: true; siteConfig: SiteConfig }
  | { ok: false; code: string; message: string };

/**
 * Builds a schema-valid draft from the latest persisted discovery snapshot and saves a new inactive config version.
 */
export async function generateAndPersistSiteConfigDraft(
  siteId: SiteId
): Promise<GenerateSiteConfigDraftResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return {
      ok: false,
      code: "site_not_found",
      message: "Site is not registered locally."
    };
  }

  const discovery = await db.repositories.discoverySnapshots.getLatest(siteId);
  if (!discovery) {
    return {
      ok: false,
      code: "discovery_missing",
      message: "Run discovery before generating a site config draft."
    };
  }

  const versions = await db.repositories.siteConfigs.listVersions(site.id);
  const nextVersion =
    versions.length > 0 ? Math.max(...versions.map((v) => v.version)) + 1 : 1;

  const id = randomUUID() as SiteConfigId;
  const now = new Date().toISOString();

  const siteConfig = buildSiteConfigDraftFromDiscovery({
    id,
    siteId: site.id,
    version: nextVersion,
    siteName: site.name,
    siteBaseUrl: site.baseUrl,
    discoverySnapshot: discovery,
    now
  });

  const row: SiteConfigVersion = {
    id,
    siteId: site.id,
    version: nextVersion,
    isActive: false,
    summary: `Draft from discovery revision ${discovery.revision}`,
    requiredSectionsComplete: false,
    document: siteConfig as unknown as JsonObject,
    createdAt: now,
    updatedAt: now
  };

  await db.repositories.siteConfigs.save(row);

  return { ok: true, siteConfig };
}
