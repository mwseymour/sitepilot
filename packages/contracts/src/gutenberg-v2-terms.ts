import { z } from "zod";

/**
 * Categories and tags on posts. A change names the whole set of terms a
 * taxonomy ends with, by term ID: SitePilot matches the model's names to the
 * site's existing terms outside the model, and works out adds and removals
 * against the post's current terms. New terms aren't created yet.
 */
export const GUTENBERG_V2_TAXONOMIES = ["category", "post_tag"] as const;

export type GutenbergV2Taxonomy = (typeof GUTENBERG_V2_TAXONOMIES)[number];

export const GUTENBERG_V2_TAXONOMY_LABELS: Readonly<
  Record<GutenbergV2Taxonomy, string>
> = {
  category: "Categories",
  post_tag: "Tags"
};

/** A term by ID, with its name for people. */
export const gutenbergV2TermRefSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(200)
  })
  .strict();

export type GutenbergV2TermRef = z.infer<typeof gutenbergV2TermRefSchema>;

/** A post's terms, ordered by ID. */
export const gutenbergV2PostTermsSchema = z
  .object({
    category: z.array(gutenbergV2TermRefSchema).max(100),
    post_tag: z.array(gutenbergV2TermRefSchema).max(100)
  })
  .strict();

export type GutenbergV2PostTerms = z.infer<typeof gutenbergV2PostTermsSchema>;

/**
 * The terms each changed taxonomy ends with. A post always keeps at least one
 * category, as WordPress requires; tags can be cleared.
 */
export const gutenbergV2TermChangesSchema = z
  .object({
    category: z.array(gutenbergV2TermRefSchema).min(1).max(50).optional(),
    post_tag: z.array(gutenbergV2TermRefSchema).max(50).optional()
  })
  .strict()
  .refine(
    (value) => value.category !== undefined || value.post_tag !== undefined,
    { message: "At least one taxonomy must change." }
  );

export type GutenbergV2TermChanges = z.infer<
  typeof gutenbergV2TermChangesSchema
>;

/** The taxonomies the editor can set on this post type. */
export const gutenbergV2TermsCapabilitySchema = z
  .object({
    taxonomies: z.array(z.enum(GUTENBERG_V2_TAXONOMIES)).min(1).max(2)
  })
  .strict();

export type GutenbergV2TermsCapability = z.infer<
  typeof gutenbergV2TermsCapabilitySchema
>;

/** Requested taxonomies whose persisted terms differ, compared by ID. */
export function gutenbergV2TermMismatches(
  changes: GutenbergV2TermChanges,
  persisted: GutenbergV2PostTerms | undefined
): GutenbergV2Taxonomy[] {
  const ids = (terms: readonly GutenbergV2TermRef[] | undefined) =>
    (terms ?? [])
      .map((term) => term.id)
      .sort((a, b) => a - b)
      .join(",");
  return GUTENBERG_V2_TAXONOMIES.filter(
    (taxonomy) =>
      changes[taxonomy] !== undefined &&
      (persisted === undefined || ids(changes[taxonomy]) !== ids(persisted[taxonomy]))
  );
}
