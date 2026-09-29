import { z } from "zod";

/**
 * Third-party (non-core, non-ACF) blocks are kept untouched by v2. This
 * read-only report shows which of them are worth supporting on a site: how
 * each one is placed, whether WordPress builds it cleanly in the site's own
 * editor, and how the site's existing content uses it. Nothing is saved.
 */

const blockNameSchema = z.string().min(1).max(200);
const shortText = (max: number) => z.string().max(max);

export const GUTENBERG_V2_THIRD_PARTY_PLACEMENTS = [
  /** Insertable anywhere in post content. */
  "top_level",
  /** Only valid inside another block (a `parent` or `ancestor` rule). */
  "inside_block",
  /** Registered but hidden from the inserter. */
  "hidden",
  /** Not allowed in this editor context by the site's settings. */
  "not_allowed"
] as const;

export const GUTENBERG_V2_THIRD_PARTY_PROBE_OUTCOMES = [
  /** Builds, serializes and reopens with the same settings. */
  "builds_cleanly",
  /** Reopening the saved markup gives different settings or blocks. */
  "changes_on_round_trip",
  /** The block's editor code changes its own settings once inserted. */
  "changes_when_edited",
  /** WordPress reports the saved markup as invalid for this block. */
  "invalid",
  /** Building the block threw. */
  "error",
  /** Not probed (placement, or the time limit). */
  "not_tested"
] as const;

const settingSchema = z
  .object({
    name: shortText(120),
    type: shortText(40).optional(),
    enum: z
      .array(z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
      .max(20)
      .optional(),
    default: shortText(400).optional(),
    source: shortText(40).optional()
  })
  .strict();

export const gutenbergV2ThirdPartyProbeBlockSchema = z
  .object({
    name: blockNameSchema,
    title: shortText(200),
    description: shortText(400).optional(),
    category: shortText(100).optional(),
    placement: z.enum(GUTENBERG_V2_THIRD_PARTY_PLACEMENTS),
    parents: z.array(blockNameSchema).max(50),
    /** `saved_markup`: the block saves its own HTML; `server`: PHP renders it. */
    rendering: z.enum(["saved_markup", "server"]),
    hasExample: z.boolean(),
    variations: z.number().int().nonnegative(),
    deprecations: z.number().int().nonnegative(),
    settings: z.array(settingSchema).max(60),
    probe: z
      .object({
        outcome: z.enum(GUTENBERG_V2_THIRD_PARTY_PROBE_OUTCOMES),
        message: shortText(600).optional(),
        /** Server-rendered blocks: whether WordPress rendered a preview. */
        preview: z.enum(["rendered", "failed", "not_checked"]),
        previewMessage: shortText(300).optional()
      })
      .strict()
  })
  .strict();

export type GutenbergV2ThirdPartyProbeBlock = z.infer<
  typeof gutenbergV2ThirdPartyProbeBlockSchema
>;

/** What the editor bridge returns from `probeThirdPartyBlocks`. */
export const gutenbergV2ThirdPartyProbeSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.third-party-probe/v2"),
    timedOut: z.boolean(),
    blocks: z.array(gutenbergV2ThirdPartyProbeBlockSchema).max(1_000)
  })
  .strict();

export type GutenbergV2ThirdPartyProbe = z.infer<
  typeof gutenbergV2ThirdPartyProbeSchema
>;

const usageExampleSchema = z
  .object({
    postId: z.number().int().positive(),
    /** The block's stored settings, as JSON. */
    attributes: shortText(4_000)
  })
  .strict();

/** What the plugin returns from the signed `block-usage` scan. */
export const gutenbergV2BlockUsageSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.block-usage/v2"),
    scannedPosts: z.number().int().nonnegative(),
    truncated: z.boolean(),
    blocks: z
      .array(
        z
          .object({
            name: blockNameSchema,
            posts: z.number().int().nonnegative(),
            uses: z.number().int().nonnegative(),
            examples: z.array(usageExampleSchema).max(3)
          })
          .strict()
      )
      .max(2_000)
  })
  .strict();

export type GutenbergV2BlockUsage = z.infer<typeof gutenbergV2BlockUsageSchema>;

export const GUTENBERG_V2_THIRD_PARTY_READINESS = [
  /** Top level and builds cleanly: needs a reviewed definition to be written. */
  "needs_definition",
  /** Top level, but the probe found a problem to look at first. */
  "needs_attention",
  /** Only valid inside another block; kept with its parent. */
  "inside_block",
  /** Hidden from the inserter or not allowed here; kept untouched. */
  "hidden"
] as const;

export const gutenbergV2ThirdPartyReportBlockSchema =
  gutenbergV2ThirdPartyProbeBlockSchema
    .extend({
      usage: z
        .object({
          posts: z.number().int().nonnegative(),
          uses: z.number().int().nonnegative(),
          examples: z.array(usageExampleSchema).max(3)
        })
        .strict(),
      readiness: z.enum(GUTENBERG_V2_THIRD_PARTY_READINESS)
    })
    .strict();

export type GutenbergV2ThirdPartyReportBlock = z.infer<
  typeof gutenbergV2ThirdPartyReportBlockSchema
>;

export const gutenbergV2ThirdPartyReportSchema = z
  .object({
    scannedPosts: z.number().int().nonnegative(),
    usageTruncated: z.boolean(),
    probeTimedOut: z.boolean(),
    blocks: z.array(gutenbergV2ThirdPartyReportBlockSchema).max(1_000)
  })
  .strict();

export type GutenbergV2ThirdPartyReport = z.infer<
  typeof gutenbergV2ThirdPartyReportSchema
>;

const READINESS_ORDER: Record<
  (typeof GUTENBERG_V2_THIRD_PARTY_READINESS)[number],
  number
> = { needs_definition: 0, needs_attention: 1, inside_block: 2, hidden: 3 };

function readiness(
  block: GutenbergV2ThirdPartyProbeBlock
): (typeof GUTENBERG_V2_THIRD_PARTY_READINESS)[number] {
  if (block.placement === "inside_block") return "inside_block";
  if (block.placement !== "top_level") return "hidden";
  return block.probe.outcome === "builds_cleanly" ||
    block.probe.outcome === "changes_when_edited"
    ? "needs_definition"
    : "needs_attention";
}

/**
 * Joins the editor probe with the content scan. Blocks worth supporting come
 * first, most used first; usage of blocks no longer registered is dropped.
 */
export function buildGutenbergV2ThirdPartyReport(
  probe: GutenbergV2ThirdPartyProbe,
  usage: GutenbergV2BlockUsage
): GutenbergV2ThirdPartyReport {
  const used = new Map(usage.blocks.map((entry) => [entry.name, entry]));
  const blocks = probe.blocks
    .map((block) => {
      const entry = used.get(block.name);
      return {
        ...block,
        usage: {
          posts: entry?.posts ?? 0,
          uses: entry?.uses ?? 0,
          examples: entry?.examples ?? []
        },
        readiness: readiness(block)
      };
    })
    .sort(
      (left, right) =>
        READINESS_ORDER[left.readiness] - READINESS_ORDER[right.readiness] ||
        right.usage.posts - left.usage.posts ||
        left.name.localeCompare(right.name)
    );
  return {
    scannedPosts: usage.scannedPosts,
    usageTruncated: usage.truncated,
    probeTimedOut: probe.timedOut,
    blocks
  };
}
