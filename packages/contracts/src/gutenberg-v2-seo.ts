import { z } from "zod";

/**
 * Plugin-neutral SEO fields. The WordPress plugin maps them to the active SEO
 * plugin's post meta (Yoast SEO first, see `Seo_Adapter`). An empty string, or
 * `indexing: "default"`, clears the field so the plugin's default applies.
 */
export const GUTENBERG_V2_SEO_FIELDS = [
  "title",
  "description",
  "focusKeyphrase",
  "canonical",
  "indexing",
  "socialTitle",
  "socialDescription"
] as const;

export type GutenbergV2SeoField = (typeof GUTENBERG_V2_SEO_FIELDS)[number];

// Values must already be what WordPress stores: plain single-line text with
// no markup, so the approved value is exactly the written value.
const plainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value === value.trim(), {
      message: "must not start or end with spaces"
    })
    .refine((value) => !/[<>\r\n\t]|\s{2}|%[a-f0-9]{2}/i.test(value), {
      message:
        "must be plain text on one line, without markup, double spaces or %-encoded characters"
    });

const canonicalSchema = z
  .string()
  .max(2_000)
  .refine((value) => value === "" || /^https?:\/\/[^\s"'<>]+$/i.test(value), {
    message: "must be an http(s) URL, or empty to clear it"
  });

const indexingSchema = z.enum(["default", "noindex", "index"]);

const seoShape = {
  title: plainText(300),
  description: plainText(1_000),
  focusKeyphrase: plainText(200),
  canonical: canonicalSchema,
  indexing: indexingSchema,
  socialTitle: plainText(300),
  socialDescription: plainText(1_000)
};

/** Current SEO values of a post, every field present. */
export const gutenbergV2SeoValuesSchema = z.object(seoShape).strict();

export type GutenbergV2SeoValues = z.infer<typeof gutenbergV2SeoValuesSchema>;

/** Requested SEO changes; only the fields that change. */
export const gutenbergV2SeoChangesSchema = z
  .object({
    title: seoShape.title.optional(),
    description: seoShape.description.optional(),
    focusKeyphrase: seoShape.focusKeyphrase.optional(),
    canonical: seoShape.canonical.optional(),
    indexing: seoShape.indexing.optional(),
    socialTitle: seoShape.socialTitle.optional(),
    socialDescription: seoShape.socialDescription.optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one SEO field change is required."
  });

export type GutenbergV2SeoChanges = z.infer<typeof gutenbergV2SeoChangesSchema>;

/** The SEO plugin v2 can write on a site, from the editor session. */
export const gutenbergV2SeoCapabilitySchema = z
  .object({
    plugin: z.literal("yoast"),
    name: z.string().max(200),
    version: z.string().max(100),
    fields: z.array(z.enum(GUTENBERG_V2_SEO_FIELDS)).max(20)
  })
  .strict();

export type GutenbergV2SeoCapability = z.infer<
  typeof gutenbergV2SeoCapabilitySchema
>;

/** The post's SEO values after the requested changes apply. */
export function gutenbergV2SeoAfterChanges(
  before: GutenbergV2SeoValues | undefined,
  changes: GutenbergV2SeoChanges
): GutenbergV2SeoValues {
  const after: GutenbergV2SeoValues = before
    ? { ...before }
    : {
        title: "",
        description: "",
        focusKeyphrase: "",
        canonical: "",
        indexing: "default",
        socialTitle: "",
        socialDescription: ""
      };
  for (const field of GUTENBERG_V2_SEO_FIELDS) {
    const value = changes[field];
    if (value !== undefined) (after as Record<string, string>)[field] = value;
  }
  return after;
}

/** Requested SEO fields whose persisted value differs. */
export function gutenbergV2SeoMismatches(
  changes: GutenbergV2SeoChanges,
  persisted: GutenbergV2SeoValues | undefined
): GutenbergV2SeoField[] {
  return (Object.keys(changes) as GutenbergV2SeoField[]).filter(
    (field) => persisted?.[field] !== changes[field]
  );
}

export const GUTENBERG_V2_SEO_FIELD_LABELS: Readonly<
  Record<GutenbergV2SeoField, string>
> = {
  title: "SEO title",
  description: "Meta description",
  focusKeyphrase: "Focus keyphrase",
  canonical: "Canonical URL",
  indexing: "Search indexing",
  socialTitle: "Social title",
  socialDescription: "Social description"
};
