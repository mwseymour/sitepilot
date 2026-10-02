import { z } from "zod";

/**
 * Categories and tags on posts. A change names the whole set of terms a
 * taxonomy ends with: existing terms by ID (SitePilot matches the model's
 * names to the site's terms outside the model, and works out adds and
 * removals against the post's current terms), and new terms by name, only
 * when the request asked to create them. The plugin creates new terms when
 * it prepares the approved write.
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

/** A term to create, by name: shown in review as new. */
export const gutenbergV2NewTermSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    new: z.literal(true)
  })
  .strict();

export type GutenbergV2NewTerm = z.infer<typeof gutenbergV2NewTermSchema>;

const termChangeEntrySchema = z.union([gutenbergV2TermRefSchema, gutenbergV2NewTermSchema]);

export type GutenbergV2TermChangeEntry = z.infer<typeof termChangeEntrySchema>;

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
    category: z.array(termChangeEntrySchema).min(1).max(50).optional(),
    post_tag: z.array(termChangeEntrySchema).max(50).optional()
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

export function isGutenbergV2NewTerm(term: GutenbergV2TermChangeEntry): term is GutenbergV2NewTerm {
  return "new" in term;
}

/** How a term's name compares: case, spacing and punctuation don't count. */
export function gutenbergV2TermKey(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Requested taxonomies whose persisted terms differ: existing terms compared
 * by ID, new ones by name, and nothing else on the post.
 */
export function gutenbergV2TermMismatches(
  changes: GutenbergV2TermChanges,
  persisted: GutenbergV2PostTerms | undefined
): GutenbergV2Taxonomy[] {
  return GUTENBERG_V2_TAXONOMIES.filter((taxonomy) => {
    const requested = changes[taxonomy];
    if (requested === undefined) return false;
    const actual = persisted?.[taxonomy];
    if (actual === undefined || actual.length !== requested.length) return true;
    return !requested.every((term) =>
      isGutenbergV2NewTerm(term)
        ? actual.some((each) => gutenbergV2TermKey(each.name) === gutenbergV2TermKey(term.name))
        : actual.some((each) => each.id === term.id)
    );
  });
}

/** A term as review shows it: new ones say so. */
export function gutenbergV2TermLabel(term: GutenbergV2TermChangeEntry): string {
  return isGutenbergV2NewTerm(term) ? `${term.name} (new)` : term.name;
}
