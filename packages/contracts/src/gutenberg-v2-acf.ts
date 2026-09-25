import { z } from "zod";

/**
 * ACF blocks are discovered per site rather than listed in the release
 * matrix. The plugin describes every `acf/*` block with all of its fields;
 * a block is authorable only after it passes a native save-and-reopen
 * fixture on that site (see `Acf_Blocks` in the WordPress plugin).
 */
export const GUTENBERG_V2_ACF_BLOCK_NAME_PATTERN = /^acf\/[a-z0-9][a-z0-9-]*$/;

export function isGutenbergV2AcfBlockName(
  name: unknown
): name is `acf/${string}` {
  return (
    typeof name === "string" && GUTENBERG_V2_ACF_BLOCK_NAME_PATTERN.test(name)
  );
}

export type GutenbergV2AcfFieldDefinition = {
  key: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  instructions?: string;
  default?: unknown;
  choices?: Array<{ value: string; label: string }>;
  multiple?: boolean;
  allowNull?: boolean;
  min?: number;
  max?: number;
  maxlength?: number;
  postTypes?: string[];
  conditional?: boolean;
  subFields?: GutenbergV2AcfFieldDefinition[];
  layouts?: Array<{
    name: string;
    label: string;
    subFields: GutenbergV2AcfFieldDefinition[];
  }>;
};

const acfFieldDefinitionSchema: z.ZodType<GutenbergV2AcfFieldDefinition> =
  z.lazy(() =>
    z
      .object({
        key: z.string().max(200),
        name: z.string().max(200),
        label: z.string().max(1_000),
        type: z.string().min(1).max(100),
        required: z.boolean(),
        instructions: z.string().max(2_000).optional(),
        default: z.unknown().optional(),
        choices: z
          .array(z.object({ value: z.string(), label: z.string() }).strict())
          .max(1_000)
          .optional(),
        multiple: z.boolean().optional(),
        allowNull: z.boolean().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        maxlength: z.number().optional(),
        postTypes: z.array(z.string()).max(100).optional(),
        conditional: z.boolean().optional(),
        subFields: z.array(acfFieldDefinitionSchema).max(200).optional(),
        layouts: z
          .array(
            z
              .object({
                name: z.string().min(1).max(200),
                label: z.string().max(1_000),
                subFields: z.array(acfFieldDefinitionSchema).max(200)
              })
              .strict()
          )
          .max(100)
          .optional()
      })
      // Newer plugins may describe more; unknown keys are ignored.
      .passthrough()
  ) as z.ZodType<GutenbergV2AcfFieldDefinition>;

export const gutenbergV2AcfBlockDefinitionSchema = z
  .object({
    name: z.string().regex(GUTENBERG_V2_ACF_BLOCK_NAME_PATTERN),
    title: z.string().max(1_000),
    description: z.string().max(2_000).optional(),
    mode: z.string().max(50),
    defaultAlign: z.string().max(50).optional(),
    innerBlocks: z.boolean(),
    allowedBlocks: z.array(z.string().max(200)).max(500),
    parent: z.array(z.string().max(200)).max(100),
    ancestor: z.array(z.string().max(200)).max(100),
    usePostMeta: z.boolean(),
    supports: z
      .object({
        align: z.union([z.boolean(), z.array(z.string().max(50)).max(10)]),
        anchor: z.boolean(),
        multiple: z.boolean()
      })
      .passthrough(),
    fields: z.array(acfFieldDefinitionSchema).max(500),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
    authorable: z.boolean(),
    unsupportedFields: z.array(z.string().max(500)).max(500).optional()
  })
  .passthrough();

export type GutenbergV2AcfBlockDefinition = z.infer<
  typeof gutenbergV2AcfBlockDefinitionSchema
>;

/** Field types whose values v2 can write (mirrors `Acf_Blocks::VALUE_TYPES`). */
export const GUTENBERG_V2_ACF_VALUE_TYPES = [
  "text",
  "textarea",
  "wysiwyg",
  "number",
  "range",
  "email",
  "url",
  "select",
  "radio",
  "button_group",
  "checkbox",
  "true_false",
  "link",
  "image",
  "file",
  "repeater",
  "group",
  "flexible_content",
  "post_object",
  "page_link",
  "relationship",
  "color_picker",
  "date_picker",
  "date_time_picker",
  "time_picker",
  "oembed"
] as const;

const VALUE_TYPES = new Set<string>(GUTENBERG_V2_ACF_VALUE_TYPES);

export const gutenbergV2BlockFixtureResultSchema = z
  .object({
    schemaVersion: z.literal("sitepilot.block-fixture-result/v2"),
    blockName: z.string().max(200),
    schemaHash: z.string().max(64),
    serializedContent: z.string().max(200_000),
    reopenedContent: z.string().max(200_000),
    issues: z
      .array(z.object({ code: z.string(), message: z.string() }).passthrough())
      .max(200)
  })
  .strict();

export type GutenbergV2BlockFixtureResult = z.infer<
  typeof gutenbergV2BlockFixtureResultSchema
>;

export const gutenbergV2BlockFixtureStatusSchema = z
  .object({
    blockName: z.string(),
    status: z.enum([
      "passed",
      "failed",
      "stale",
      "untested",
      "unsupported",
      "unregistered"
    ]),
    testedAt: z.string().optional(),
    message: z.string().optional()
  })
  .passthrough();

export type GutenbergV2BlockFixtureStatus = z.infer<
  typeof gutenbergV2BlockFixtureStatusSchema
>;

function token(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/colour/g, "color");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findField(
  fields: readonly GutenbergV2AcfFieldDefinition[],
  requested: string
): GutenbergV2AcfFieldDefinition | undefined {
  return (
    fields.find((field) => field.name === requested) ??
    fields.find(
      (field) =>
        token(field.name) === token(requested) ||
        (field.key !== "" && field.key === requested) ||
        (field.label !== "" && token(field.label) === token(requested))
    )
  );
}

export function gutenbergV2AcfChoiceValue(
  field: GutenbergV2AcfFieldDefinition,
  requested: unknown
): string | undefined {
  if (typeof requested !== "string" && typeof requested !== "number")
    return undefined;
  const wanted = token(String(requested));
  return (field.choices ?? []).find(
    (choice) => token(choice.value) === wanted || token(choice.label) === wanted
  )?.value;
}

function choiceList(field: GutenbergV2AcfFieldDefinition): string {
  return (field.choices ?? [])
    .map((choice) =>
      choice.label && choice.label !== choice.value
        ? `${choice.value} (${choice.label})`
        : choice.value
    )
    .join(", ");
}

function isSafeUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/^\s*(javascript|data|vbscript):/i.test(value) &&
    /^(https?:\/\/|\/|#|\?)/i.test(value.trim())
  );
}

export type GutenbergV2AcfDataOptions = {
  /**
   * An edit of an existing block: leave out fields the edit does not
   * mention (they keep their stored values) instead of filling defaults.
   */
  partial?: boolean;
};

export class GutenbergV2AcfDataError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "GutenbergV2AcfDataError";
    this.issues = issues;
  }
}

/**
 * Converts friendly field values (`{colour: "grey", items: [{title: "A"}]}`)
 * into ACF's stored block data (`{colour: "bg-gray-300", _colour:
 * "field_…", items: "1", items_0_title: "A", _items_0_title: "field_…"}`).
 * Choice labels become choice values, omitted fields take their defaults,
 * and anything that does not fit the field definitions is an error.
 */
export function gutenbergV2AcfDataFromFields(
  definition: GutenbergV2AcfBlockDefinition,
  values: unknown,
  options: GutenbergV2AcfDataOptions = {}
): Record<string, unknown> {
  const issues: string[] = [];
  const data: Record<string, unknown> = {};
  if (values !== undefined && !isRecord(values)) {
    throw new GutenbergV2AcfDataError([
      `${definition.name} fields must be an object keyed by field name.`
    ]);
  }
  storeFields(
    definition.fields,
    values ?? {},
    "",
    data,
    issues,
    definition.name,
    options.partial === true
  );
  if (issues.length > 0) throw new GutenbergV2AcfDataError(issues);
  return data;
}

function storeFields(
  fields: readonly GutenbergV2AcfFieldDefinition[],
  values: Record<string, unknown>,
  prefix: string,
  data: Record<string, unknown>,
  issues: string[],
  label: string,
  partial: boolean
): void {
  const writable = fields.filter(
    (field) => field.name !== "" && VALUE_TYPES.has(field.type)
  );
  const matched = new Map<GutenbergV2AcfFieldDefinition, unknown>();
  for (const [key, value] of Object.entries(values)) {
    const field = findField(fields, key);
    if (!field) {
      issues.push(
        `${label} has no field "${key}"; its fields are ${
          writable.map((entry) => entry.name).join(", ") || "none"
        }.`
      );
      continue;
    }
    if (!VALUE_TYPES.has(field.type)) {
      issues.push(
        `${label} field ${field.name} is a ${field.type} field, which v2 cannot write.`
      );
      continue;
    }
    matched.set(field, value);
  }
  for (const field of writable) {
    const path = `${prefix}${field.name}`;
    let value = matched.get(field);
    if (value === undefined && !partial) {
      if (field.default !== undefined) {
        value = field.default;
      } else if (field.required && !field.conditional) {
        issues.push(`${label} field ${field.name} is required.`);
        continue;
      }
    }
    if (value === undefined) continue;
    const stored = storedValue(field, value, path, data, issues, label);
    if (stored === undefined) continue;
    data[path] = stored;
    data[`_${path}`] = field.key;
  }
}

function storedValue(
  field: GutenbergV2AcfFieldDefinition,
  value: unknown,
  path: string,
  data: Record<string, unknown>,
  issues: string[],
  label: string
): unknown {
  const where = `${label} field ${path}`;
  if (value === null || value === "") {
    if (field.required && !field.conditional) {
      issues.push(`${where} is required.`);
      return undefined;
    }
    return "";
  }
  switch (field.type) {
    case "select":
    case "radio":
    case "button_group":
    case "checkbox": {
      const multiple = field.type === "checkbox" || field.multiple === true;
      const requested = Array.isArray(value) ? value : [value];
      if (!multiple && requested.length !== 1) {
        issues.push(`${where} takes one choice.`);
        return undefined;
      }
      const resolved = requested.map((entry) =>
        gutenbergV2AcfChoiceValue(field, entry)
      );
      if (resolved.some((entry) => entry === undefined)) {
        issues.push(
          `${where} must be one of: ${choiceList(field)} (got ${JSON.stringify(value)}).`
        );
        return undefined;
      }
      return multiple ? resolved : resolved[0];
    }
    case "true_false":
      if (
        value === true ||
        value === 1 ||
        value === "1" ||
        value === "true" ||
        value === "yes"
      )
        return "1";
      if (
        value === false ||
        value === 0 ||
        value === "0" ||
        value === "false" ||
        value === "no"
      )
        return "0";
      issues.push(`${where} must be true or false.`);
      return undefined;
    case "number":
    case "range": {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) {
        issues.push(`${where} must be a number.`);
        return undefined;
      }
      if (field.min !== undefined && number < field.min) {
        issues.push(`${where} must be at least ${field.min}.`);
        return undefined;
      }
      if (field.max !== undefined && number > field.max) {
        issues.push(`${where} must be at most ${field.max}.`);
        return undefined;
      }
      return String(number);
    }
    case "link": {
      const link = isRecord(value) ? value : { url: value };
      if (!isSafeUrl(link.url)) {
        issues.push(
          `${where} must be {"title","url"} with an http(s), relative or # URL.`
        );
        return undefined;
      }
      return {
        title: typeof link.title === "string" ? link.title : "",
        url: link.url.trim(),
        target: link.target === "_blank" ? "_blank" : ""
      };
    }
    case "url":
    case "oembed":
      if (!isSafeUrl(value)) {
        issues.push(`${where} must be an http(s), relative or # URL.`);
        return undefined;
      }
      return value.trim();
    case "email":
      if (
        typeof value !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ) {
        issues.push(`${where} must be an email address.`);
        return undefined;
      }
      return value.trim();
    case "image":
    case "file":
    case "post_object":
    case "page_link":
    case "relationship": {
      const multiple = field.type === "relationship" || field.multiple === true;
      const ids = (Array.isArray(value) ? value : [value]).map((entry) =>
        typeof entry === "number" ? entry : Number(entry)
      );
      if (
        ids.some((id) => !Number.isInteger(id) || id < 1) ||
        (!multiple && ids.length !== 1)
      ) {
        issues.push(
          field.type === "image" || field.type === "file"
            ? `${where} must be an existing media library ID; leave it out when no such ID was given.`
            : `${where} must be ${multiple ? "a list of post IDs" : "one post ID"}.`
        );
        return undefined;
      }
      return multiple ? ids : ids[0];
    }
    case "repeater": {
      if (!Array.isArray(value) || !value.every(isRecord)) {
        issues.push(
          `${where} must be a list of rows, each an object of its sub fields.`
        );
        return undefined;
      }
      if (
        field.min !== undefined &&
        field.min > 0 &&
        value.length < field.min
      ) {
        issues.push(`${where} needs at least ${field.min} rows.`);
        return undefined;
      }
      if (
        field.max !== undefined &&
        field.max > 0 &&
        value.length > field.max
      ) {
        issues.push(`${where} allows at most ${field.max} rows.`);
        return undefined;
      }
      value.forEach((row, index) =>
        storeFields(
          field.subFields ?? [],
          row,
          `${path}_${index}_`,
          data,
          issues,
          label,
          false
        )
      );
      return String(value.length);
    }
    case "group":
      if (!isRecord(value)) {
        issues.push(`${where} must be an object of its sub fields.`);
        return undefined;
      }
      storeFields(
        field.subFields ?? [],
        value,
        `${path}_`,
        data,
        issues,
        label,
        false
      );
      return "";
    case "flexible_content": {
      if (!Array.isArray(value) || !value.every(isRecord)) {
        issues.push(`${where} must be a list of {"layout": name, ...fields}.`);
        return undefined;
      }
      const layouts: string[] = [];
      value.forEach((row, index) => {
        const { layout: layoutName, ...rest } = row;
        const layout = (field.layouts ?? []).find(
          (entry) =>
            typeof layoutName === "string" &&
            token(entry.name) === token(layoutName)
        );
        if (!layout) {
          issues.push(
            `${where} row ${index} needs a layout: ${(field.layouts ?? []).map((entry) => entry.name).join(", ")}.`
          );
          return;
        }
        layouts.push(layout.name);
        storeFields(
          layout.subFields,
          rest,
          `${path}_${index}_`,
          data,
          issues,
          label,
          false
        );
      });
      return layouts;
    }
    default:
      if (typeof value !== "string" && typeof value !== "number") {
        issues.push(`${where} must be text.`);
        return undefined;
      }
      if (
        field.maxlength !== undefined &&
        field.maxlength > 0 &&
        String(value).length > field.maxlength
      ) {
        issues.push(`${where} allows at most ${field.maxlength} characters.`);
        return undefined;
      }
      return String(value);
  }
}

/**
 * Deterministic sample values for a block's fixture: every field the
 * block can hold gets a representative value, so the test proves the whole
 * schema round-trips, not just the defaults.
 */
export function gutenbergV2AcfSampleFields(
  definition: GutenbergV2AcfBlockDefinition,
  siteUrl: string
): Record<string, unknown> {
  return sampleFields(definition.fields, siteUrl, 0);
}

function sampleFields(
  fields: readonly GutenbergV2AcfFieldDefinition[],
  siteUrl: string,
  depth: number
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === "" || !VALUE_TYPES.has(field.type)) continue;
    const value = sampleValue(field, siteUrl, depth);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

function sampleValue(
  field: GutenbergV2AcfFieldDefinition,
  siteUrl: string,
  depth: number
): unknown {
  const firstChoice = field.choices?.[0]?.value;
  switch (field.type) {
    case "select":
    case "radio":
    case "button_group": {
      const preferred =
        field.default === undefined
          ? undefined
          : gutenbergV2AcfChoiceValue(field, field.default);
      const choice = preferred ?? firstChoice;
      if (choice === undefined) return undefined;
      return field.multiple ? [choice] : choice;
    }
    case "checkbox":
      return firstChoice === undefined ? undefined : [firstChoice];
    case "true_false":
      return true;
    case "number":
    case "range":
      return (
        field.min ?? (typeof field.default === "number" ? field.default : 1)
      );
    case "link":
      return { title: "SitePilot test link", url: siteUrl, target: "" };
    case "url":
      return siteUrl;
    case "email":
      return "sitepilot-test@example.com";
    case "image":
    case "file":
    case "post_object":
    case "page_link":
    case "relationship":
      // No safe sample ID exists on every site; leave these to their default.
      return undefined;
    case "repeater":
      return depth > 3
        ? undefined
        : [sampleFields(field.subFields ?? [], siteUrl, depth + 1)];
    case "group":
      return depth > 3
        ? undefined
        : sampleFields(field.subFields ?? [], siteUrl, depth + 1);
    case "flexible_content": {
      const layout = field.layouts?.[0];
      return layout === undefined || depth > 3
        ? undefined
        : [
            {
              layout: layout.name,
              ...sampleFields(layout.subFields, siteUrl, depth + 1)
            }
          ];
    }
    case "wysiwyg":
      return "<p>SitePilot block test.</p>";
    case "color_picker":
      return typeof field.default === "string" ? field.default : "#000000";
    case "date_picker":
      return "20260101";
    case "date_time_picker":
      return "2026-01-01 09:00:00";
    case "time_picker":
      return "09:00:00";
    case "oembed":
      return undefined;
    default:
      return typeof field.default === "string" && field.default !== ""
        ? field.default
        : "SitePilot block test";
  }
}

/** One line per field, for the planner prompt. */
export function describeGutenbergV2AcfFields(
  fields: readonly GutenbergV2AcfFieldDefinition[],
  indent = ""
): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    if (field.name === "" || !VALUE_TYPES.has(field.type)) continue;
    const parts = [
      `${indent}- ${field.name} (${field.type}${field.required ? ", required" : ""})`
    ];
    if (field.label && field.label !== field.name)
      parts.push(`"${field.label}"`);
    if (field.choices?.length) parts.push(`choices: ${choiceList(field)}`);
    if (field.multiple) parts.push("multiple");
    if (field.default !== undefined)
      parts.push(`default ${JSON.stringify(field.default)}`);
    if (field.instructions) parts.push(`- ${field.instructions.slice(0, 160)}`);
    lines.push(parts.join(" "));
    if (field.type === "repeater" || field.type === "group") {
      lines.push(
        ...describeGutenbergV2AcfFields(field.subFields ?? [], `${indent}  `)
      );
    }
    for (const layout of field.layouts ?? []) {
      lines.push(`${indent}  layout ${layout.name}:`);
      lines.push(
        ...describeGutenbergV2AcfFields(layout.subFields, `${indent}    `)
      );
    }
  }
  return lines;
}
