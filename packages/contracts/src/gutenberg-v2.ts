import { z } from "zod";

import { isoTimestampSchema, jsonValueSchema, urlSchema } from "./common.js";

export const GUTENBERG_V2_SCHEMA_VERSION = "sitepilot.block-plan/v2" as const;

export const GUTENBERG_V2_LIMITS = {
  maxPlanBytes: 1_000_000,
  maxSerializedContentBytes: 2_000_000,
  maxBlocks: 500,
  maxDepth: 12,
  maxChildrenPerBlock: 100,
  maxTextLength: 100_000,
  maxAttributeJsonBytes: 64_000,
  maxValidationIssues: 200,
  maxDiagnosticMarkupLength: 4_096,
  maxMediaItems: 20,
  maxMediaBindingItems: 20,
  maxMediaAssetBytes: 10_000_000,
  maxMediaBindingRequestBytes: 25_000_000,
  maxOperations: 100
} as const;

export const GUTENBERG_V2_SUPPORT_MATRIX = [
  { name: "core/paragraph", mode: "author", dynamic: false },
  { name: "core/heading", mode: "author", dynamic: false },
  { name: "core/group", mode: "author", dynamic: false },
  { name: "core/columns", mode: "author", dynamic: false },
  { name: "core/column", mode: "author", dynamic: false },
  { name: "core/image", mode: "author", dynamic: false },
  { name: "core/list", mode: "author", dynamic: false },
  { name: "core/list-item", mode: "author", dynamic: false },
  { name: "core/buttons", mode: "author", dynamic: false },
  { name: "core/button", mode: "author", dynamic: false },
  { name: "core/quote", mode: "author", dynamic: false },
  { name: "core/spacer", mode: "author", dynamic: false },
  { name: "core/table", mode: "author", dynamic: false },
  { name: "core/pullquote", mode: "author", dynamic: false },
  { name: "core/media-text", mode: "author", dynamic: false },
  {
    name: "core/latest-posts",
    mode: "fixture_required",
    dynamic: true
  },
  {
    name: "acf/container",
    mode: "fixture_required",
    dynamic: true
  }
] as const;

export type GutenbergV2SupportedBlockName =
  (typeof GUTENBERG_V2_SUPPORT_MATRIX)[number]["name"];

const identifierSchema = z.string().trim().min(1).max(200);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const boundedTextSchema = z.string().max(GUTENBERG_V2_LIMITS.maxTextLength);
const cssClassNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*$/);
const anchorSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z][A-Za-z0-9_:.-]*$/);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeAttributeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([a-f0-9]+)|colon|tab|newline|amp|quot|apos|lt|gt);?/gi,
    (match, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        const codePoint = Number.parseInt(decimal, 10);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
      }
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
      }
      const named = match.toLowerCase().replace(/[&;]/g, "");
      return (
        {
          colon: ":",
          tab: "\t",
          newline: "\n",
          amp: "&",
          quot: '"',
          apos: "'",
          lt: "<",
          gt: ">"
        }[named] ?? match
      );
    }
  );
}

function isAllowedLink(value: string): boolean {
  const decoded = Array.from(decodeAttributeEntities(value))
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x20)
    .join("");
  return (
    !/^(?:javascript|data|vbscript):/i.test(decoded) &&
    (decoded.startsWith("/") ||
      decoded.startsWith("#") ||
      /^https?:\/\//i.test(decoded))
  );
}

const richTextSchema = boundedTextSchema.superRefine((value, context) => {
  if (/<\s*!--\s*\/?wp:/i.test(decodeAttributeEntities(value))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Rich text must not contain serialized Gutenberg block delimiters."
    });
  }
  if (
    /<\/?(?:script|style|iframe|object|embed|form|input|textarea|select|button)\b/i.test(
      value
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rich text contains a forbidden HTML element."
    });
  }
  if (/\son[a-z]+\s*=/i.test(value) || /(?:javascript|data):/i.test(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rich text contains an executable URL or event handler."
    });
  }
  for (const match of value.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const tagName = (match[1] ?? "").toLowerCase();
    if (
      ![
        "a",
        "abbr",
        "b",
        "br",
        "code",
        "em",
        "mark",
        "s",
        "span",
        "strong",
        "sub",
        "sup"
      ].includes(tagName)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Rich text element <${match[1] ?? "unknown"}> is not allowed.`
      });
      continue;
    }
    const tag = match[0];
    if (/^<\//.test(tag)) continue;
    const attributesText = tag
      .replace(/^<[a-z][a-z0-9-]*/i, "")
      .replace(/\/?\s*>$/, "");
    const allowed =
      tagName === "a"
        ? new Set(["href", "target", "rel"])
        : tagName === "span"
          ? new Set(["class"])
          : new Set<string>();
    const attributePattern =
      /\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let consumed = "";
    for (const attribute of attributesText.matchAll(attributePattern)) {
      consumed += attribute[0];
      const attributeName = (attribute[1] ?? "").toLowerCase();
      const attributeValue = attribute[2] ?? attribute[3] ?? "";
      if (!allowed.has(attributeName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Attribute ${attributeName} is not allowed on rich text <${tagName}>.`
        });
      }
      if (attributeName === "href" && !isAllowedLink(attributeValue)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rich text contains an unsafe link URL."
        });
      }
      if (
        attributeName === "target" &&
        !["_self", "_blank"].includes(attributeValue)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rich text contains an unsupported link target."
        });
      }
    }
    if (attributesText.replace(consumed, "").trim().length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Rich text <${tagName}> contains malformed or unquoted attributes.`
      });
    }
  }
  const withoutAllowedTags = value.replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, "");
  if (/[<>]/.test(withoutAllowedTags)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rich text contains malformed HTML."
    });
  }
});

const linkUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    isAllowedLink,
    "Links must be a relative, fragment, HTTP, or HTTPS URL."
  );

const dimensionSchema = z.union([
  z.number().nonnegative().max(10_000),
  z.string().regex(/^\d+(?:\.\d+)?(?:px|%|em|rem|vw|vh)$/)
]);

const colorStyleSchema = z
  .object({
    background: z.string().trim().min(1).max(100).optional(),
    text: z.string().trim().min(1).max(100).optional()
  })
  .strict();

const spacingStyleSchema = z
  .object({
    margin: z
      .object({
        top: dimensionSchema.optional(),
        right: dimensionSchema.optional(),
        bottom: dimensionSchema.optional(),
        left: dimensionSchema.optional()
      })
      .strict()
      .optional(),
    padding: z
      .object({
        top: dimensionSchema.optional(),
        right: dimensionSchema.optional(),
        bottom: dimensionSchema.optional(),
        left: dimensionSchema.optional()
      })
      .strict()
      .optional(),
    blockGap: dimensionSchema.optional()
  })
  .strict();

const blockStyleSchema = z
  .object({
    color: colorStyleSchema.optional(),
    spacing: spacingStyleSchema.optional()
  })
  .strict();

const basePresentationAttributes = {
  anchor: anchorSchema.optional(),
  className: cssClassNameSchema.optional(),
  style: blockStyleSchema.optional()
};

const tableCellSchema = z
  .object({
    content: richTextSchema,
    tag: z.enum(["td", "th"]),
    colspan: positiveIntegerSchema.max(100).optional(),
    rowspan: positiveIntegerSchema.max(100).optional()
  })
  .strict();

const tableRowSchema = z
  .object({
    cells: z.array(tableCellSchema).min(1).max(100)
  })
  .strict();

const acfDataValueSchema = z.union([
  z.string().max(GUTENBERG_V2_LIMITS.maxTextLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema).max(1_000),
  z.record(jsonValueSchema)
]);

export type GutenbergV2BlockNode = {
  ref: string;
  name: GutenbergV2SupportedBlockName;
  attributes: Record<string, unknown>;
  children: GutenbergV2BlockNode[];
};

const childrenSchema: z.ZodType<GutenbergV2BlockNode[]> = z.lazy(() =>
  z
    .array(gutenbergV2BlockNodeSchema)
    .max(GUTENBERG_V2_LIMITS.maxChildrenPerBlock)
);

function nodeSchema<T extends GutenbergV2SupportedBlockName>(
  name: T,
  attributes: z.ZodTypeAny
): z.ZodDiscriminatedUnionOption<"name"> {
  return z
    .object({
      ref: identifierSchema,
      name: z.literal(name),
      attributes,
      children: childrenSchema
    })
    .strict();
}

export const gutenbergV2BlockNodeSchema: z.ZodType<GutenbergV2BlockNode> =
  z.lazy(
    () =>
      z.discriminatedUnion("name", [
        nodeSchema(
          "core/paragraph",
          z
            .object({
              content: richTextSchema,
              align: z.enum(["left", "center", "right"]).optional(),
              dropCap: z.boolean().optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/heading",
          z
            .object({
              content: richTextSchema,
              level: z.number().int().min(1).max(6),
              textAlign: z.enum(["left", "center", "right"]).optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/group",
          z
            .object({
              tagName: z
                .enum(["div", "section", "main", "aside", "header", "footer"])
                .optional(),
              align: z.enum(["wide", "full"]).optional(),
              layout: z
                .discriminatedUnion("type", [
                  z.object({ type: z.literal("default") }).strict(),
                  z
                    .object({
                      type: z.literal("constrained"),
                      contentSize: dimensionSchema.optional(),
                      wideSize: dimensionSchema.optional(),
                      justifyContent: z
                        .enum(["left", "center", "right"])
                        .optional()
                    })
                    .strict(),
                  z
                    .object({
                      type: z.literal("flex"),
                      orientation: z
                        .enum(["horizontal", "vertical"])
                        .optional(),
                      justifyContent: z
                        .enum(["left", "center", "right", "space-between"])
                        .optional(),
                      flexWrap: z.enum(["wrap", "nowrap"]).optional()
                    })
                    .strict()
                ])
                .optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/columns",
          z
            .object({
              align: z.enum(["wide", "full"]).optional(),
              isStackedOnMobile: z.boolean().optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/column",
          z
            .object({
              width: dimensionSchema.optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/image",
          z
            .object({
              mediaRef: identifierSchema,
              id: positiveIntegerSchema.optional(),
              url: urlSchema.optional(),
              alt: z.string().max(2_000),
              caption: richTextSchema.optional(),
              sizeSlug: z
                .enum(["thumbnail", "medium", "medium_large", "large", "full"])
                .optional(),
              linkDestination: z
                .enum(["none", "media", "attachment", "custom"])
                .optional(),
              linkUrl: linkUrlSchema.optional(),
              align: z
                .enum(["left", "center", "right", "wide", "full"])
                .optional(),
              ...basePresentationAttributes
            })
            .strict()
            .superRefine((attributes, context) => {
              if (
                attributes.linkDestination === "custom" &&
                !attributes.linkUrl
              ) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["linkUrl"],
                  message: "A custom image link requires linkUrl."
                });
              }
              if (
                attributes.linkDestination !== "custom" &&
                attributes.linkUrl
              ) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["linkUrl"],
                  message: "linkUrl is only valid for a custom image link."
                });
              }
            })
        ),
        nodeSchema(
          "core/list",
          z
            .object({
              ordered: z.boolean(),
              reversed: z.boolean().optional(),
              start: positiveIntegerSchema.optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/list-item",
          z
            .object({ content: richTextSchema, ...basePresentationAttributes })
            .strict()
        ),
        nodeSchema(
          "core/buttons",
          z
            .object({
              layout: z
                .object({
                  type: z.literal("flex"),
                  justifyContent: z
                    .enum(["left", "center", "right", "space-between"])
                    .optional(),
                  orientation: z.enum(["horizontal", "vertical"]).optional()
                })
                .strict()
                .optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/button",
          z
            .object({
              text: richTextSchema,
              url: linkUrlSchema,
              linkTarget: z.enum(["_self", "_blank"]).optional(),
              rel: z.string().trim().min(1).max(500).optional(),
              width: z
                .union([
                  z.literal(25),
                  z.literal(50),
                  z.literal(75),
                  z.literal(100)
                ])
                .optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/quote",
          z
            .object({
              citation: richTextSchema.optional(),
              textAlign: z.enum(["left", "center", "right"]).optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/spacer",
          z
            .object({
              height: dimensionSchema,
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/table",
          z
            .object({
              head: z.array(tableRowSchema).max(100).optional(),
              body: z.array(tableRowSchema).min(1).max(1_000),
              foot: z.array(tableRowSchema).max(100).optional(),
              caption: richTextSchema.optional(),
              hasFixedLayout: z.boolean().optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/pullquote",
          z
            .object({
              value: richTextSchema,
              citation: richTextSchema.optional(),
              textAlign: z.enum(["left", "center", "right"]).optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/media-text",
          z
            .object({
              mediaRef: identifierSchema,
              mediaId: positiveIntegerSchema.optional(),
              mediaUrl: urlSchema.optional(),
              mediaAlt: z.string().max(2_000),
              mediaPosition: z.enum(["left", "right"]),
              mediaWidth: z.number().int().min(10).max(90).optional(),
              verticalAlignment: z.enum(["top", "center", "bottom"]).optional(),
              isStackedOnMobile: z.boolean().optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "core/latest-posts",
          z
            .object({
              postsToShow: z.number().int().min(1).max(100),
              order: z.enum(["asc", "desc"]).optional(),
              orderBy: z.enum(["date", "title"]).optional(),
              displayPostDate: z.boolean().optional(),
              displayFeaturedImage: z.boolean().optional(),
              postLayout: z.enum(["list", "grid"]).optional(),
              columns: z.number().int().min(2).max(6).optional(),
              ...basePresentationAttributes
            })
            .strict()
        ),
        nodeSchema(
          "acf/container",
          z
            .object({
              data: z.record(acfDataValueSchema),
              mode: z.enum(["auto", "preview", "edit"]).optional(),
              ...basePresentationAttributes
            })
            .strict()
        )
      ]) as unknown as z.ZodType<GutenbergV2BlockNode>
  );

const stagedMediaTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

export const gutenbergV2MediaIntentSchema = z
  .object({
    ref: identifierSchema,
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("library_attachment"),
          attachmentId: positiveIntegerSchema,
          checksum: sha256Schema
        })
        .strict(),
      z
        .object({
          kind: z.literal("staged_asset"),
          stagedAssetId: identifierSchema,
          checksum: sha256Schema,
          mediaType: stagedMediaTypeSchema,
          byteLength: positiveIntegerSchema
        })
        .strict()
    ]),
    alt: z.string().max(2_000),
    caption: richTextSchema.optional()
  })
  .strict();

const expectedFieldSchema = z
  .object({
    valueHash: sha256Schema,
    value: z.string().max(GUTENBERG_V2_LIMITS.maxTextLength).optional()
  })
  .strict();

export const gutenbergV2ExistingTargetSchema = z
  .object({
    postId: positiveIntegerSchema,
    postType: z.enum(["post", "page"]),
    sourceRevision: identifierSchema,
    sourceContentHash: sha256Schema,
    expectedFields: z
      .object({
        title: expectedFieldSchema.optional(),
        excerpt: expectedFieldSchema.optional()
      })
      .strict()
  })
  .strict();

const postFieldChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(1_000).optional(),
    excerpt: z.string().max(GUTENBERG_V2_LIMITS.maxTextLength).optional()
  })
  .strict()
  .refine((value) => value.title !== undefined || value.excerpt !== undefined, {
    message: "At least one post field change is required."
  });

const nodeTargetSchema = z
  .object({
    path: z
      .array(nonNegativeIntegerSchema)
      .min(1)
      .max(GUTENBERG_V2_LIMITS.maxDepth),
    ref: identifierSchema.optional(),
    expectedFingerprint: sha256Schema
  })
  .strict();

export const gutenbergV2ScopedOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: identifierSchema,
      type: z.literal("insert_blocks"),
      parent: z
        .object({
          path: z
            .array(nonNegativeIntegerSchema)
            .max(GUTENBERG_V2_LIMITS.maxDepth),
          ref: identifierSchema.optional(),
          expectedFingerprint: sha256Schema
        })
        .strict(),
      index: nonNegativeIntegerSchema,
      blocks: z
        .array(gutenbergV2BlockNodeSchema)
        .min(1)
        .max(GUTENBERG_V2_LIMITS.maxBlocks)
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      type: z.literal("edit_block"),
      target: nodeTargetSchema,
      replacement: gutenbergV2BlockNodeSchema
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      type: z.literal("remove_block"),
      target: nodeTargetSchema
    })
    .strict()
]);

const planBaseShape = {
  schemaVersion: z.literal(GUTENBERG_V2_SCHEMA_VERSION),
  planId: identifierSchema,
  siteId: identifierSchema,
  media: z
    .array(gutenbergV2MediaIntentSchema)
    .max(GUTENBERG_V2_LIMITS.maxMediaItems)
};

const createDraftPlanSchema = z
  .object({
    ...planBaseShape,
    operation: z.literal("create_draft"),
    target: z.object({ postType: z.enum(["post", "page"]) }).strict(),
    postFields: z
      .object({
        title: z.string().trim().min(1).max(1_000),
        excerpt: z.string().max(GUTENBERG_V2_LIMITS.maxTextLength).optional(),
        status: z.literal("draft")
      })
      .strict(),
    blocks: z
      .array(gutenbergV2BlockNodeSchema)
      .min(1)
      .max(GUTENBERG_V2_LIMITS.maxBlocks)
  })
  .strict();

const replaceContentPlanSchema = z
  .object({
    ...planBaseShape,
    operation: z.literal("replace_content"),
    target: gutenbergV2ExistingTargetSchema,
    postFields: postFieldChangesSchema.optional(),
    blocks: z
      .array(gutenbergV2BlockNodeSchema)
      .min(1)
      .max(GUTENBERG_V2_LIMITS.maxBlocks)
  })
  .strict();

const applyOperationsPlanSchema = z
  .object({
    ...planBaseShape,
    operation: z.literal("apply_operations"),
    target: gutenbergV2ExistingTargetSchema,
    postFields: postFieldChangesSchema.optional(),
    operations: z
      .array(gutenbergV2ScopedOperationSchema)
      .min(1)
      .max(GUTENBERG_V2_LIMITS.maxOperations)
  })
  .strict();

function collectPlanBlocks(plan: {
  blocks?: GutenbergV2BlockNode[];
  operations?: z.infer<typeof gutenbergV2ScopedOperationSchema>[];
}): GutenbergV2BlockNode[] {
  const blocks = [...(plan.blocks ?? [])];
  for (const operation of plan.operations ?? []) {
    if (operation.type === "insert_blocks") {
      blocks.push(...operation.blocks);
    } else if (operation.type === "edit_block") {
      blocks.push(operation.replacement);
    }
  }
  return blocks;
}

function validatePlanStructure(
  plan:
    | z.infer<typeof createDraftPlanSchema>
    | z.infer<typeof replaceContentPlanSchema>
    | z.infer<typeof applyOperationsPlanSchema>,
  context: z.RefinementCtx
): void {
  if (byteLength(JSON.stringify(plan)) > GUTENBERG_V2_LIMITS.maxPlanBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The v2 plan exceeds the maximum encoded size."
    });
  }

  const refs = new Set<string>();
  const mediaRefs = new Set(plan.media.map((item) => item.ref));
  const imageMediaRefs = new Set<string>();
  if (mediaRefs.size !== plan.media.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["media"],
      message: "Media refs must be unique."
    });
  }

  let count = 0;
  const visit = (
    node: GutenbergV2BlockNode,
    depth: number,
    path: Array<string | number>
  ): void => {
    if (depth > GUTENBERG_V2_LIMITS.maxDepth) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: "Block nesting exceeds the supported depth."
      });
      return;
    }
    count += 1;
    if (count > GUTENBERG_V2_LIMITS.maxBlocks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: "The v2 plan exceeds the maximum total block count."
      });
      return;
    }
    if (refs.has(node.ref)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "ref"],
        message: `Duplicate block ref: ${node.ref}`
      });
    }
    refs.add(node.ref);
    if (
      byteLength(JSON.stringify(node.attributes)) >
      GUTENBERG_V2_LIMITS.maxAttributeJsonBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "attributes"],
        message: "Block attributes exceed the supported size."
      });
    }

    const allowedChildren: Partial<
      Record<GutenbergV2SupportedBlockName, GutenbergV2SupportedBlockName[]>
    > = {
      "core/columns": ["core/column"],
      "core/list": ["core/list-item"],
      "core/buttons": ["core/button"]
    };
    const mustBeEmpty = new Set<GutenbergV2SupportedBlockName>([
      "core/paragraph",
      "core/heading",
      "core/image",
      "core/list-item",
      "core/button",
      "core/spacer",
      "core/table",
      "core/pullquote",
      "core/latest-posts"
    ]);
    if (mustBeEmpty.has(node.name) && node.children.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "children"],
        message: `${node.name} cannot contain child blocks in v2.`
      });
    }
    const names = allowedChildren[node.name];
    if (names && node.children.some((child) => !names.includes(child.name))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "children"],
        message: `${node.name} contains an unsupported child type.`
      });
    }
    if (
      ["core/columns", "core/list", "core/buttons"].includes(node.name) &&
      node.children.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "children"],
        message: `${node.name} requires at least one child.`
      });
    }
    const attributes = node.attributes as Record<string, unknown>;
    const mediaRef =
      typeof attributes.mediaRef === "string" ? attributes.mediaRef : undefined;
    if (mediaRef && !mediaRefs.has(mediaRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "attributes", "mediaRef"],
        message: `Unknown media ref: ${mediaRef}`
      });
    }
    if (node.name === "core/image" && mediaRef) imageMediaRefs.add(mediaRef);
    node.children.forEach((child, index) =>
      visit(child, depth + 1, [...path, "children", index])
    );
  };

  collectPlanBlocks(plan).forEach((block, index) =>
    visit(block, 1, ["blocks", index])
  );
  plan.media.forEach((media, index) => {
    if (media.caption !== undefined && !imageMediaRefs.has(media.ref)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["media", index, "caption"],
        message:
          "A media caption requires an explicit core/image block using the same media ref."
      });
    }
  });
  if (count > GUTENBERG_V2_LIMITS.maxBlocks) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The v2 plan exceeds the maximum total block count."
    });
  }
}

const parsedGutenbergV2BlockPlanSchema = z
  .discriminatedUnion("operation", [
    createDraftPlanSchema,
    replaceContentPlanSchema,
    applyOperationsPlanSchema
  ])
  .superRefine(validatePlanStructure);

const rawPlanStructureSchema = z.unknown().superRefine((raw, context) => {
  let encodedSize: number;
  try {
    encodedSize = byteLength(JSON.stringify(raw));
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The v2 plan must be JSON serializable.",
      fatal: true
    });
    return z.NEVER;
  }
  if (encodedSize > GUTENBERG_V2_LIMITS.maxPlanBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The v2 plan exceeds the maximum encoded size.",
      fatal: true
    });
    return z.NEVER;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  const pending: Array<{ value: unknown; depth: number }> = [];
  if (Array.isArray(root.blocks)) {
    root.blocks.forEach((value) => pending.push({ value, depth: 1 }));
  }
  if (Array.isArray(root.operations)) {
    for (const operation of root.operations) {
      if (
        operation !== null &&
        typeof operation === "object" &&
        !Array.isArray(operation)
      ) {
        const record = operation as Record<string, unknown>;
        if (Array.isArray(record.blocks))
          record.blocks.forEach((value) => pending.push({ value, depth: 1 }));
        if (record.replacement !== undefined)
          pending.push({ value: record.replacement, depth: 1 });
      }
    }
  }
  let count = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    count += 1;
    if (count > GUTENBERG_V2_LIMITS.maxBlocks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The v2 plan exceeds the maximum total block count.",
        fatal: true
      });
      return z.NEVER;
    }
    if (entry.depth > GUTENBERG_V2_LIMITS.maxDepth) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Block nesting exceeds the supported depth.",
        fatal: true
      });
      return z.NEVER;
    }
    if (
      entry.value === null ||
      typeof entry.value !== "object" ||
      Array.isArray(entry.value)
    )
      continue;
    const children = (entry.value as Record<string, unknown>).children;
    if (Array.isArray(children)) {
      if (children.length > GUTENBERG_V2_LIMITS.maxChildrenPerBlock) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A block exceeds the maximum direct child count.",
          fatal: true
        });
        return z.NEVER;
      }
      children.forEach((value) =>
        pending.push({ value, depth: entry.depth + 1 })
      );
    }
  }
});

export const gutenbergV2BlockPlanSchema = rawPlanStructureSchema.pipe(
  parsedGutenbergV2BlockPlanSchema
);

export const gutenbergV2ValidationFailureCodeSchema = z.enum([
  "schema_invalid",
  "request_too_large",
  "unregistered_block",
  "disallowed_block",
  "unsupported_v2_block",
  "invalid_block_markup",
  "content_changed",
  "stale_source",
  "runtime_changed",
  "editor_unavailable",
  "permission_denied",
  "persisted_content_invalid",
  "unexpected_block",
  "missing_block",
  "fallback_block",
  "invalid_nesting",
  "locked_structure",
  "media_changed",
  "approval_invalid",
  "approval_expired",
  "conditional_commit_failed",
  "idempotency_conflict",
  "verification_failed",
  "rollback_conflict"
]);

export const gutenbergV2ValidationIssueSchema = z
  .object({
    code: gutenbergV2ValidationFailureCodeSchema,
    severity: z.enum(["error", "warning"]),
    phase: z.enum([
      "schema",
      "policy",
      "compile",
      "prepare",
      "commit",
      "verify",
      "rollback"
    ]),
    message: z.string().trim().min(1).max(2_000),
    blockName: z.string().trim().min(1).max(200).optional(),
    blockPath: z
      .array(nonNegativeIntegerSchema)
      .max(GUTENBERG_V2_LIMITS.maxDepth)
      .optional(),
    planRef: identifierSchema.optional(),
    expected: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxDiagnosticMarkupLength)
      .optional(),
    actual: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxDiagnosticMarkupLength)
      .optional()
  })
  .strict();

export const gutenbergV2ValidationReportSchema = z
  .object({
    outcome: z.enum(["valid", "invalid"]),
    expectedBlockCount: nonNegativeIntegerSchema,
    observedBlockCount: nonNegativeIntegerSchema,
    issues: z
      .array(gutenbergV2ValidationIssueSchema)
      .max(GUTENBERG_V2_LIMITS.maxValidationIssues),
    contentPreservation: z
      .object({
        passed: z.boolean(),
        checked: z.array(
          z.enum([
            "text",
            "inline_markup",
            "links",
            "media",
            "captions",
            "ordering",
            "layout",
            "post_fields"
          ])
        ),
        intentHash: sha256Schema,
        observedIntentHash: sha256Schema
      })
      .strict()
  })
  .strict()
  .superRefine((report, context) => {
    const hasError = report.issues.some((issue) => issue.severity === "error");
    if ((report.outcome === "valid") === hasError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Validation outcome does not match its error issues."
      });
    }
    if (report.outcome === "valid" && !report.contentPreservation.passed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid report must pass content preservation."
      });
    }
    if (
      report.outcome === "valid" &&
      report.expectedBlockCount !== report.observedBlockCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A valid report must observe the complete expected block inventory."
      });
    }
    if (
      report.outcome === "valid" &&
      report.contentPreservation.intentHash !==
        report.contentPreservation.observedIntentHash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid report must preserve the semantic intent hash."
      });
    }
    const requiredChecks = [
      "text",
      "inline_markup",
      "links",
      "media",
      "captions",
      "ordering",
      "layout"
    ] as const;
    if (
      report.outcome === "valid" &&
      requiredChecks.some(
        (check) => !report.contentPreservation.checked.includes(check)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A valid report must cover every required preservation dimension."
      });
    }
  });

export const gutenbergV2CapabilityBlockSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    registered: z.boolean(),
    allowed: z.boolean(),
    v2Support: z.enum([
      "author",
      "author_when_reviewed",
      "preserve_only",
      "unsupported"
    ]),
    dynamic: z.boolean(),
    attributeSchemaHash: sha256Schema,
    allowedParents: z.array(z.string().trim().min(1).max(200)).max(100),
    allowedAncestors: z.array(z.string().trim().min(1).max(200)).max(100),
    allowedChildren: z.array(z.string().trim().min(1).max(200)).max(100),
    supportsHtml: z.boolean(),
    lock: z.enum(["none", "insert", "move", "all"])
  })
  .strict();

export const gutenbergV2EditorCapabilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.editor-capabilities/v2"),
    siteId: identifierSchema,
    siteUrl: urlSchema,
    bridgeVersion: identifierSchema,
    wordpressVersion: identifierSchema,
    gutenbergVersion: identifierSchema.optional(),
    fingerprint: sha256Schema,
    capturedAt: isoTimestampSchema,
    context: z
      .object({
        postType: z.enum(["post", "page"]),
        userId: positiveIntegerSchema,
        userRoles: z.array(identifierSchema).min(1).max(100),
        theme: identifierSchema,
        pluginFingerprint: sha256Schema,
        editorSettingsFingerprint: sha256Schema
      })
      .strict(),
    blocks: z.array(gutenbergV2CapabilityBlockSchema).max(2_000)
  })
  .strict();

export const gutenbergV2MediaManifestEntrySchema = z
  .object({
    ref: identifierSchema,
    approvedChecksum: sha256Schema,
    finalChecksum: sha256Schema.optional(),
    attachmentId: positiveIntegerSchema.optional(),
    url: urlSchema.optional(),
    alt: z.string().max(2_000),
    caption: richTextSchema.optional()
  })
  .strict();

const sourceStateSchema = z
  .object({
    postId: positiveIntegerSchema.optional(),
    revision: identifierSchema.optional(),
    contentHash: sha256Schema.optional(),
    affectedFieldsHash: sha256Schema
  })
  .strict();

const requestedPostFieldsSchema = z
  .object({
    title: z.string().max(1_000).optional(),
    excerpt: z.string().max(GUTENBERG_V2_LIMITS.maxTextLength).optional(),
    status: z.literal("draft").optional()
  })
  .strict();

export const gutenbergV2CompiledCandidateSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.compiled-candidate/v2"),
    candidateId: identifierSchema,
    planId: identifierSchema,
    siteId: identifierSchema,
    operation: z.enum(["create_draft", "replace_content", "apply_operations"]),
    intent: gutenbergV2BlockPlanSchema,
    requestedPostFields: requestedPostFieldsSchema,
    serializedContent: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    contentHash: sha256Schema,
    intentHash: sha256Schema,
    requestedFieldsHash: sha256Schema,
    sourceState: sourceStateSchema,
    capabilityFingerprint: sha256Schema,
    mediaManifest: z
      .array(gutenbergV2MediaManifestEntrySchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaItems),
    mediaManifestHash: sha256Schema,
    validation: gutenbergV2ValidationReportSchema,
    reviewArtifact: z
      .object({
        structureDiffRef: identifierSchema,
        previewRefs: z.array(identifierSchema).min(1).max(10)
      })
      .strict(),
    compiledAt: isoTimestampSchema
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.siteId !== candidate.intent.siteId ||
      candidate.planId !== candidate.intent.planId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Candidate identity does not match its intent."
      });
    }
    if (candidate.operation !== candidate.intent.operation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Candidate operation does not match its intent."
      });
    }
    const intendedFields =
      "postFields" in candidate.intent && candidate.intent.postFields
        ? candidate.intent.postFields
        : {};
    if (
      JSON.stringify(candidate.requestedPostFields) !==
      JSON.stringify(intendedFields)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPostFields"],
        message: "Candidate post fields do not match its normalized intent."
      });
    }
    if (candidate.validation.outcome !== "valid") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validation"],
        message: "A compiled candidate must have a valid report."
      });
    }
    if (
      candidate.validation.expectedBlockCount === 0 &&
      collectPlanBlocks(candidate.intent).length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validation", "expectedBlockCount"],
        message: "A non-empty intent cannot produce a 0/0 validation result."
      });
    }
  });

export const gutenbergV2ApprovalBindingSchema = z
  .object({
    candidateId: identifierSchema,
    siteId: identifierSchema,
    operation: z.enum(["create_draft", "replace_content", "apply_operations"]),
    intentHash: sha256Schema,
    contentHash: sha256Schema,
    requestedFieldsHash: sha256Schema,
    affectedFieldsHash: sha256Schema,
    sourceContentHash: sha256Schema.optional(),
    sourceRevision: identifierSchema.optional(),
    capabilityFingerprint: sha256Schema,
    mediaManifestHash: sha256Schema
  })
  .strict();

export const gutenbergV2ApprovalSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.approval/v2"),
    approvalId: identifierSchema,
    approverId: identifierSchema,
    approvedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    binding: gutenbergV2ApprovalBindingSchema
  })
  .strict()
  .refine(
    (approval) =>
      Date.parse(approval.expiresAt) > Date.parse(approval.approvedAt),
    {
      path: ["expiresAt"],
      message: "Approval expiry must be after approval time."
    }
  );

export const gutenbergV2MediaMappingSchema = z
  .object({
    ref: identifierSchema,
    approvedChecksum: sha256Schema,
    finalChecksum: sha256Schema,
    attachmentId: positiveIntegerSchema,
    url: urlSchema
  })
  .strict();

const mediaBindingBaseShape = {
  ref: identifierSchema,
  bindingId: sha256Schema,
  approvedChecksum: sha256Schema
};

export const gutenbergV2MediaBindingItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...mediaBindingBaseShape,
      kind: z.literal("library_attachment"),
      attachmentId: positiveIntegerSchema
    })
    .strict(),
  z
    .object({
      ...mediaBindingBaseShape,
      kind: z.literal("staged_asset"),
      stagedAssetId: identifierSchema,
      mediaType: stagedMediaTypeSchema,
      byteLength: positiveIntegerSchema.max(
        GUTENBERG_V2_LIMITS.maxMediaAssetBytes
      ),
      fileName: z.string().regex(/^[a-f0-9]{64}\.(?:jpe?g|png|webp|gif)$/),
      dataBase64: z
        .string()
        .min(1)
        .max(Math.ceil(GUTENBERG_V2_LIMITS.maxMediaAssetBytes / 3) * 4 + 4)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
      alt: z.string().max(2_000),
      caption: richTextSchema.optional()
    })
    .strict()
]);

export const gutenbergV2MediaBindingsRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.media-bindings-request/v2"),
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    siteId: identifierSchema,
    items: z
      .array(gutenbergV2MediaBindingItemSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaBindingItems)
  })
  .strict()
  .superRefine((request, context) => {
    if (
      new Set(request.items.map((item) => item.ref)).size !==
      request.items.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Media binding refs must be unique."
      });
    }
    if (
      new Set(request.items.map((item) => item.bindingId)).size !==
      request.items.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Media binding IDs must be unique."
      });
    }
    const stagedBytes = request.items.reduce(
      (total, item) =>
        total + (item.kind === "staged_asset" ? item.byteLength : 0),
      0
    );
    if (stagedBytes > GUTENBERG_V2_LIMITS.maxMediaBindingRequestBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Staged media exceeds the maximum binding request size."
      });
    }
  });

export const gutenbergV2MediaBindingsResponseSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.media-bindings-response/v2"),
    mapping: z
      .array(gutenbergV2MediaMappingSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaBindingItems),
    createdMediaIds: z
      .array(positiveIntegerSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaBindingItems)
  })
  .strict();

export const gutenbergV2EditorVerifyRequestSchema = z
  .object({
    serializedContent: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    expectedSerializedContent: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    intent: gutenbergV2BlockPlanSchema,
    mediaMapping: z
      .array(gutenbergV2MediaMappingSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaItems)
  })
  .strict();

export const gutenbergV2EditorPreviewRequestSchema = z
  .object({
    serializedContent: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    intent: gutenbergV2BlockPlanSchema,
    viewport: z.enum(["desktop", "mobile"]),
    mediaMapping: z
      .array(gutenbergV2MediaMappingSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaBindingItems)
      .optional(),
    previewMediaMapping: z
      .array(
        z
          .object({
            ref: identifierSchema,
            approvedChecksum: sha256Schema,
            dataUrl: z
              .string()
              .max(
                Math.ceil(GUTENBERG_V2_LIMITS.maxMediaAssetBytes / 3) * 4 + 64
              )
              .regex(
                /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/
              )
          })
          .strict()
      )
      .max(GUTENBERG_V2_LIMITS.maxMediaBindingItems)
      .optional()
  })
  .strict()
  .superRefine((request, context) => {
    const mapping = request.previewMediaMapping ?? [];
    if (new Set(mapping.map((item) => item.ref)).size !== mapping.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previewMediaMapping"],
        message: "Preview media refs must be unique."
      });
    }
  });

export const gutenbergV2EditorPreviewResultSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.editor-preview-result/v2"),
    renderedContentHash: sha256Schema,
    previewMediaManifestHash: sha256Schema,
    rootSelector: z.literal("#sitepilot-v2-preview")
  })
  .strict();

export const gutenbergV2PreparedCommitSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.prepared-commit/v2"),
    preparedCommitId: identifierSchema,
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    approvalId: identifierSchema,
    candidateId: identifierSchema,
    siteId: identifierSchema,
    operation: z.enum(["create_draft", "replace_content", "apply_operations"]),
    postId: positiveIntegerSchema.optional(),
    sourceRevision: identifierSchema.optional(),
    sourceContentHash: sha256Schema.optional(),
    requestedFieldsHash: sha256Schema,
    affectedFieldsHash: sha256Schema,
    capabilityFingerprint: sha256Schema,
    intentHash: sha256Schema,
    approvedContentHash: sha256Schema,
    mediaManifestHash: sha256Schema,
    mediaMapping: z
      .array(gutenbergV2MediaMappingSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaItems),
    finalContent: z.string().max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    finalContentHash: sha256Schema,
    serverPreparedContentHash: sha256Schema,
    serverPreparedFieldsHash: sha256Schema,
    preparedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema
  })
  .strict();

export const gutenbergV2ExecutionStateSchema = z.enum([
  "planned",
  "compiling",
  "review_ready",
  "approved",
  "preparing",
  "committing",
  "verifying",
  "succeeded",
  "rejected",
  "stale_approval",
  "pre_write_failed",
  "post_write_verification_failed",
  "rolled_back",
  "rollback_conflict",
  "manual_intervention_required"
]);

export const gutenbergV2ExecutionResultSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.execution-result/v2"),
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    state: gutenbergV2ExecutionStateSchema,
    postId: positiveIntegerSchema.optional(),
    persistedRevision: identifierSchema.optional(),
    persistedContentHash: sha256Schema.optional(),
    persistedFieldsHash: sha256Schema.optional(),
    verification: gutenbergV2ValidationReportSchema.optional(),
    beforeStateRef: identifierSchema.optional(),
    createdMediaIds: z
      .array(positiveIntegerSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaItems),
    retry: z
      .object({
        retryable: z.boolean(),
        retryAfterSeconds: nonNegativeIntegerSchema.optional()
      })
      .strict(),
    rollback: z
      .object({
        attempted: z.boolean(),
        outcome: z.enum(["not_required", "succeeded", "conflict", "failed"]),
        evidenceRef: identifierSchema.optional()
      })
      .strict(),
    auditRef: identifierSchema,
    completedAt: isoTimestampSchema.optional()
  })
  .strict();

export const gutenbergV2JobRecordSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.execution-journal/v2"),
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    siteId: identifierSchema,
    planHash: sha256Schema,
    state: gutenbergV2ExecutionStateSchema,
    revision: nonNegativeIntegerSchema,
    candidateId: identifierSchema.optional(),
    approvalId: identifierSchema.optional(),
    preparedCommitId: identifierSchema.optional(),
    candidate: gutenbergV2CompiledCandidateSchema.optional(),
    approval: gutenbergV2ApprovalSchema.optional(),
    preparedCommit: gutenbergV2PreparedCommitSchema.optional(),
    beforeStateRef: identifierSchema.optional(),
    postId: positiveIntegerSchema.optional(),
    writtenContentHash: sha256Schema.optional(),
    persistedRevision: identifierSchema.optional(),
    persistedFieldsHash: sha256Schema.optional(),
    createdMediaIds: z
      .array(positiveIntegerSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaItems)
      .optional(),
    result: gutenbergV2ExecutionResultSchema.optional(),
    failure: gutenbergV2ValidationIssueSchema.optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema
  })
  .strict();

export const gutenbergV2EditorSessionRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.editor-session-request/v2"),
    executionId: identifierSchema,
    siteId: identifierSchema,
    context: z
      .object({
        postType: z.enum(["post", "page"]),
        postId: positiveIntegerSchema.optional(),
        expectedCapabilityFingerprint: sha256Schema.optional()
      })
      .strict()
  })
  .strict();

export const gutenbergV2EditorSessionResponseSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.editor-session/v2"),
    bootstrapToken: z.string().min(32).max(4_096),
    bootstrapUrl: urlSchema,
    expiresAt: isoTimestampSchema,
    context: z
      .object({
        executionId: identifierSchema,
        siteId: identifierSchema,
        postType: z.enum(["post", "page"]),
        postId: positiveIntegerSchema.optional()
      })
      .strict()
  })
  .strict();

export const gutenbergV2EditorBootstrapResponseSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.editor-bootstrap/v2"),
    editorUrl: urlSchema,
    expiresAt: isoTimestampSchema
  })
  .strict();

export const gutenbergV2EditorCompileResultSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.editor-compile-result/v2"),
    planId: identifierSchema,
    operation: z.enum(["create_draft", "replace_content", "apply_operations"]),
    serializedContent: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    contentHash: sha256Schema,
    intentHash: sha256Schema,
    capabilityFingerprint: sha256Schema,
    validation: gutenbergV2ValidationReportSchema,
    compiledAt: isoTimestampSchema
  })
  .strict();

export const gutenbergV2SourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.source-snapshot/v2"),
    siteId: identifierSchema,
    postId: positiveIntegerSchema,
    postType: z.enum(["post", "page"]),
    revision: identifierSchema,
    rawContent: z.string().max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    contentHash: sha256Schema,
    fields: z
      .object({
        title: z.string().max(1_000),
        excerpt: z.string().max(GUTENBERG_V2_LIMITS.maxTextLength),
        status: z.string().trim().min(1).max(100)
      })
      .strict(),
    fieldsHash: sha256Schema,
    blockTreeFingerprint: sha256Schema,
    blockIndex: z
      .array(
        z
          .object({
            path: z
              .array(nonNegativeIntegerSchema)
              .min(1)
              .max(GUTENBERG_V2_LIMITS.maxDepth),
            name: z.string().trim().min(1).max(200),
            fingerprint: sha256Schema
          })
          .strict()
      )
      .max(GUTENBERG_V2_LIMITS.maxBlocks)
  })
  .strict();

export const gutenbergV2PrepareCommitRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.prepare-commit-request/v2"),
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    candidate: gutenbergV2CompiledCandidateSchema,
    approval: gutenbergV2ApprovalSchema,
    mediaMapping: z
      .array(gutenbergV2MediaMappingSchema)
      .max(GUTENBERG_V2_LIMITS.maxMediaItems),
    finalSerializedContent: z
      .string()
      .max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    finalContentHash: sha256Schema
  })
  .strict();

export const gutenbergV2PrepareCommitResponseSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.prepare-commit-response/v2"),
    preparedCommit: gutenbergV2PreparedCommitSchema,
    beforeStateRef: identifierSchema
  })
  .strict();

export const gutenbergV2CommitRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.commit-request/v2"),
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    preparedCommitId: identifierSchema
  })
  .strict();

export const gutenbergV2CommitReceiptSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.commit-receipt/v2"),
    executionId: identifierSchema,
    idempotencyKey: identifierSchema,
    preparedCommitId: identifierSchema,
    disposition: z.enum(["applied", "reconciled"]),
    postId: positiveIntegerSchema,
    persistedRevision: identifierSchema,
    persistedContentHash: sha256Schema,
    persistedFieldsHash: sha256Schema,
    beforeStateRef: identifierSchema,
    committedAt: isoTimestampSchema
  })
  .strict();

export const gutenbergV2ReconcileRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.reconcile-request/v2"),
    siteId: identifierSchema,
    executionId: identifierSchema,
    idempotencyKey: identifierSchema
  })
  .strict();

export const gutenbergV2ReconcileResponseSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.reconcile-response/v2"),
    receipt: gutenbergV2CommitReceiptSchema.nullable()
  })
  .strict();

export const gutenbergV2ReadbackRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.readback-request/v2"),
    siteId: identifierSchema,
    executionId: identifierSchema,
    postId: positiveIntegerSchema
  })
  .strict();

export const gutenbergV2ReadbackSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.readback/v2"),
    siteId: identifierSchema,
    executionId: identifierSchema,
    postId: positiveIntegerSchema,
    postType: z.enum(["post", "page"]),
    revision: identifierSchema,
    rawContent: z.string().max(GUTENBERG_V2_LIMITS.maxSerializedContentBytes),
    contentHash: sha256Schema,
    fields: z
      .object({
        title: z.string().max(1_000),
        excerpt: z.string().max(GUTENBERG_V2_LIMITS.maxTextLength),
        status: z.string().trim().min(1).max(100)
      })
      .strict(),
    fieldsHash: sha256Schema
  })
  .strict();

export const gutenbergV2RecoverRequestSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.recover-request/v2"),
    siteId: identifierSchema,
    executionId: identifierSchema,
    postId: positiveIntegerSchema,
    beforeStateRef: identifierSchema,
    expectedWrittenContentHash: sha256Schema,
    expectedWrittenRevision: identifierSchema,
    expectedWrittenFieldsHash: sha256Schema
  })
  .strict();

export const gutenbergV2RecoverResponseSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.recover-response/v2"),
    outcome: z.enum(["restored", "conflict", "failed"]),
    evidenceRef: identifierSchema.optional()
  })
  .strict();

export type GutenbergV2BlockPlan = z.infer<typeof gutenbergV2BlockPlanSchema>;
export type GutenbergV2ScopedOperation = z.infer<
  typeof gutenbergV2ScopedOperationSchema
>;
export type GutenbergV2MediaIntent = z.infer<
  typeof gutenbergV2MediaIntentSchema
>;
export type GutenbergV2MediaMapping = z.infer<
  typeof gutenbergV2MediaMappingSchema
>;
export type GutenbergV2MediaBindingItem = z.infer<
  typeof gutenbergV2MediaBindingItemSchema
>;
export type GutenbergV2MediaBindingsRequest = z.infer<
  typeof gutenbergV2MediaBindingsRequestSchema
>;
export type GutenbergV2MediaBindingsResponse = z.infer<
  typeof gutenbergV2MediaBindingsResponseSchema
>;
export type GutenbergV2ValidationIssue = z.infer<
  typeof gutenbergV2ValidationIssueSchema
>;
export type GutenbergV2ValidationReport = z.infer<
  typeof gutenbergV2ValidationReportSchema
>;
export type GutenbergV2EditorCapabilitySnapshot = z.infer<
  typeof gutenbergV2EditorCapabilitySnapshotSchema
>;
export type GutenbergV2CompiledCandidate = z.infer<
  typeof gutenbergV2CompiledCandidateSchema
>;
export type GutenbergV2ApprovalBinding = z.infer<
  typeof gutenbergV2ApprovalBindingSchema
>;
export type GutenbergV2Approval = z.infer<typeof gutenbergV2ApprovalSchema>;
export type GutenbergV2PreparedCommit = z.infer<
  typeof gutenbergV2PreparedCommitSchema
>;
export type GutenbergV2ExecutionState = z.infer<
  typeof gutenbergV2ExecutionStateSchema
>;
export type GutenbergV2ExecutionResult = z.infer<
  typeof gutenbergV2ExecutionResultSchema
>;
export type GutenbergV2JobRecord = z.infer<typeof gutenbergV2JobRecordSchema>;
export type GutenbergV2EditorSessionRequest = z.infer<
  typeof gutenbergV2EditorSessionRequestSchema
>;
export type GutenbergV2EditorSessionResponse = z.infer<
  typeof gutenbergV2EditorSessionResponseSchema
>;
export type GutenbergV2EditorBootstrapResponse = z.infer<
  typeof gutenbergV2EditorBootstrapResponseSchema
>;
export type GutenbergV2EditorCompileResult = z.infer<
  typeof gutenbergV2EditorCompileResultSchema
>;
export type GutenbergV2EditorVerifyRequest = z.infer<
  typeof gutenbergV2EditorVerifyRequestSchema
>;
export type GutenbergV2EditorPreviewRequest = z.infer<
  typeof gutenbergV2EditorPreviewRequestSchema
>;
export type GutenbergV2PreviewMediaMapping = NonNullable<
  GutenbergV2EditorPreviewRequest["previewMediaMapping"]
>[number];
export type GutenbergV2EditorPreviewResult = z.infer<
  typeof gutenbergV2EditorPreviewResultSchema
>;
export type GutenbergV2SourceSnapshot = z.infer<
  typeof gutenbergV2SourceSnapshotSchema
>;
export type GutenbergV2PrepareCommitRequest = z.infer<
  typeof gutenbergV2PrepareCommitRequestSchema
>;
export type GutenbergV2PrepareCommitResponse = z.infer<
  typeof gutenbergV2PrepareCommitResponseSchema
>;
export type GutenbergV2CommitRequest = z.infer<
  typeof gutenbergV2CommitRequestSchema
>;
export type GutenbergV2CommitReceipt = z.infer<
  typeof gutenbergV2CommitReceiptSchema
>;
export type GutenbergV2ReconcileRequest = z.infer<
  typeof gutenbergV2ReconcileRequestSchema
>;
export type GutenbergV2ReconcileResponse = z.infer<
  typeof gutenbergV2ReconcileResponseSchema
>;
export type GutenbergV2ReadbackRequest = z.infer<
  typeof gutenbergV2ReadbackRequestSchema
>;
export type GutenbergV2Readback = z.infer<typeof gutenbergV2ReadbackSchema>;
export type GutenbergV2RecoverRequest = z.infer<
  typeof gutenbergV2RecoverRequestSchema
>;
export type GutenbergV2RecoverResponse = z.infer<
  typeof gutenbergV2RecoverResponseSchema
>;
