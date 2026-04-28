import {
  actionPlanSchema,
  type Action,
  type ActionPlan
} from "@sitepilot/contracts";

type ImageSourceProvider = "wikimedia" | "unsplash";

type ResolvedImage = {
  url: string;
  provider: ImageSourceProvider;
};

type SearchCandidate = ResolvedImage & {
  width?: number;
  height?: number;
};

const IMAGE_REQUEST_RE =
  /\b(image|images|photo|photos|picture|pictures|headshot|headshots|featured image|thumbnail)\b/i;
const GENERIC_ALT_RE =
  /^(image|photo|picture|featured image|thumbnail|example image|random image)$/i;

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeActionType(type: string): string {
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imageBlockHtml(attrs: Record<string, unknown>): string {
  const url = typeof attrs.url === "string" ? attrs.url : "";
  if (url.length === 0) {
    return "";
  }
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  const id =
    typeof attrs.id === "number"
      ? attrs.id
      : typeof attrs.id === "string"
        ? Number.parseInt(attrs.id, 10)
        : 0;
  const classes = ["wp-block-image"];
  const sizeSlug = typeof attrs.sizeSlug === "string" ? attrs.sizeSlug.trim() : "";
  if (sizeSlug.length > 0) {
    classes.push(`size-${escapeHtml(sizeSlug)}`);
  }
  const imageClass = Number.isFinite(id) && id > 0 ? ` class="wp-image-${id}"` : "";
  return `<figure class="${classes.join(" ")}"><img src="${escapeHtml(url)}" alt="${escapeHtml(
    alt
  )}"${imageClass}/></figure>`;
}

function mediaTextWrapperOpen(attrs: Record<string, unknown>): string {
  const classNames = ["wp-block-media-text"];
  if (attrs.mediaPosition === "right") {
    classNames.push("has-media-on-the-right");
  }
  if (attrs.isStackedOnMobile === true) {
    classNames.push("is-stacked-on-mobile");
  }
  if (
    typeof attrs.verticalAlignment === "string" &&
    attrs.verticalAlignment.trim().length > 0
  ) {
    classNames.push(
      `is-vertically-aligned-${escapeHtml(attrs.verticalAlignment.trim())}`
    );
  }
  if (attrs.imageFill === true) {
    classNames.push("is-image-fill-element");
  }
  let style = "";
  if (
    typeof attrs.mediaWidth === "number" &&
    Number.isFinite(attrs.mediaWidth) &&
    attrs.mediaWidth !== 50
  ) {
    const width = String(attrs.mediaWidth);
    style =
      attrs.mediaPosition === "right"
        ? ` style="grid-template-columns:auto ${width}%"`
        : ` style="grid-template-columns:${width}% auto"`;
  }
  return `<div class="${classNames.join(" ")}"${style}>`;
}

function mediaTextMediaFigureHtml(attrs: Record<string, unknown>): string {
  const mediaType = typeof attrs.mediaType === "string" ? attrs.mediaType : "";
  const mediaUrl =
    typeof attrs.mediaUrl === "string" ? attrs.mediaUrl.trim() : "";
  if (mediaUrl.length === 0 || mediaType !== "image") {
    return '<figure class="wp-block-media-text__media"></figure>';
  }

  const mediaAlt = typeof attrs.mediaAlt === "string" ? attrs.mediaAlt : "";
  const mediaId =
    typeof attrs.mediaId === "number"
      ? attrs.mediaId
      : typeof attrs.mediaId === "string"
        ? Number.parseInt(attrs.mediaId, 10)
        : 0;
  const mediaSizeSlug =
    typeof attrs.mediaSizeSlug === "string" && attrs.mediaSizeSlug.trim().length > 0
      ? attrs.mediaSizeSlug.trim()
      : "full";
  const classes: string[] = [];
  if (Number.isFinite(mediaId) && mediaId > 0) {
    classes.push(`wp-image-${mediaId}`);
    classes.push(`size-${escapeHtml(mediaSizeSlug)}`);
  }
  const img = `<img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(
    mediaAlt
  )}"${classes.length > 0 ? ` class="${classes.join(" ")}"` : ""}/>`;
  return `<figure class="wp-block-media-text__media">${img}</figure>`;
}

function mediaTextInnerHtml(attrs: Record<string, unknown>, contentHtml: string): string {
  const mediaFigure = mediaTextMediaFigureHtml(attrs);
  const content = `<div class="wp-block-media-text__content">${contentHtml}</div>`;
  if (attrs.mediaPosition === "right") {
    return `${mediaTextWrapperOpen(attrs)}${content}${mediaFigure}</div>`;
  }
  return `${mediaTextWrapperOpen(attrs)}${mediaFigure}${content}</div>`;
}

function stripHtmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeQuery(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\s+/g, " ");
}

function imageQueryFromContext(input: {
  explicitQuery?: string | null;
  altText?: string | null;
  requestText: string;
}): string | null {
  const explicit = normalizeQuery(input.explicitQuery);
  if (explicit) {
    return explicit;
  }

  const altText = normalizeQuery(input.altText);
  if (altText && !GENERIC_ALT_RE.test(altText)) {
    return altText;
  }

  const requestText = normalizeQuery(input.requestText);
  return requestText;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Image source request failed (${response.status})`);
  }
  return (await response.json()) as unknown;
}

async function validateDirectImageUrl(url: string): Promise<string | null> {
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return null;
  }

  const validate = async (method: "HEAD" | "GET"): Promise<string | null> => {
    const response = await fetch(trimmed, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      return null;
    }
    return response.url || trimmed;
  };

  try {
    return (await validate("HEAD")) ?? (await validate("GET"));
  } catch {
    return null;
  }
}

async function searchWikimediaCommons(query: string): Promise<SearchCandidate[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "5",
    prop: "imageinfo",
    iiprop: "url|mime|size",
    iiurlwidth: "1600",
    format: "json",
    origin: "*"
  });
  const payload = objectValue(
    await fetchJson(`https://commons.wikimedia.org/w/api.php?${params.toString()}`)
  );
  const queryResult = objectValue(payload.query);
  const pages = objectValue(queryResult.pages);

  const candidates: SearchCandidate[] = [];
  for (const page of Object.values(pages)) {
    const record = objectValue(page);
    const imageInfo = Array.isArray(record.imageinfo)
      ? objectValue(record.imageinfo[0])
      : {};
    const url =
      typeof imageInfo.thumburl === "string"
        ? imageInfo.thumburl
        : typeof imageInfo.url === "string"
          ? imageInfo.url
          : "";
    const mime = typeof imageInfo.mime === "string" ? imageInfo.mime : "";
    if (url.length === 0 || !mime.startsWith("image/")) {
      continue;
    }
    candidates.push({
      url,
      provider: "wikimedia",
      ...(typeof imageInfo.thumbwidth === "number"
        ? { width: imageInfo.thumbwidth }
        : typeof imageInfo.width === "number"
          ? { width: imageInfo.width }
          : {}),
      ...(typeof imageInfo.thumbheight === "number"
        ? { height: imageInfo.thumbheight }
        : typeof imageInfo.height === "number"
          ? { height: imageInfo.height }
          : {})
    });
  }
  return candidates;
}

async function searchUnsplash(query: string): Promise<SearchCandidate[]> {
  const params = new URLSearchParams({
    query,
    per_page: "5",
    page: "1"
  });
  const payload = objectValue(
    await fetchJson(`https://unsplash.com/napi/search/photos?${params.toString()}`)
  );
  const results = Array.isArray(payload.results) ? payload.results : [];

  const candidates: SearchCandidate[] = [];
  for (const entry of results) {
    const record = objectValue(entry);
    const urls = objectValue(record.urls);
    const url =
      typeof urls.regular === "string"
        ? urls.regular
        : typeof urls.full === "string"
          ? urls.full
          : "";
    if (url.length === 0) {
      continue;
    }
    candidates.push({
      url,
      provider: "unsplash",
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {})
    });
  }
  return candidates;
}

async function findImageForQuery(query: string): Promise<ResolvedImage | null> {
  const providers = [searchWikimediaCommons, searchUnsplash] as const;
  for (const provider of providers) {
    let candidates: SearchCandidate[] = [];
    try {
      candidates = await provider(query);
    } catch {
      candidates = [];
    }

    for (const candidate of candidates) {
      const validated = await validateDirectImageUrl(candidate.url);
      if (validated) {
        return {
          url: validated,
          provider: candidate.provider
        };
      }
    }
  }

  return null;
}

export async function resolveExternalImageReference(input: {
  currentUrl?: string | null;
  explicitQuery?: string | null;
  altText?: string | null;
  requestText: string;
}): Promise<ResolvedImage | null> {
  const currentUrl = normalizeQuery(input.currentUrl);
  if (currentUrl) {
    const validated = await validateDirectImageUrl(currentUrl);
    if (validated) {
      return {
        url: validated,
        provider: currentUrl.includes("unsplash.com") ? "unsplash" : "wikimedia"
      };
    }
  }

  const query = imageQueryFromContext(input);
  if (!query) {
    return null;
  }

  return await findImageForQuery(query);
}

function rewriteImageBlock(
  block: Record<string, unknown>,
  url: string
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    ...objectValue(block.attrs),
    url,
    ...(typeof objectValue(block.attrs).src === "string" ? { src: url } : {})
  };
  const html = imageBlockHtml(attrs);
  return {
    ...block,
    attrs,
    innerHTML: html,
    innerContent: [html]
  };
}

function rewriteMediaTextBlock(
  block: Record<string, unknown>,
  url: string
): Record<string, unknown> {
  const originalAttrs = objectValue(block.attrs);
  const attrs: Record<string, unknown> = {
    ...originalAttrs,
    mediaType: "image",
    mediaUrl: url
  };
  const innerBlocks = Array.isArray(block.innerBlocks) ? block.innerBlocks : [];
  const contentHtml = innerBlocks
    .map((innerBlock) => {
      const record = objectValue(innerBlock);
      return typeof record.innerHTML === "string" ? record.innerHTML : "";
    })
    .join("");
  const html = mediaTextInnerHtml(attrs, contentHtml);
  const innerContent =
    attrs.mediaPosition === "right"
      ? [
          mediaTextWrapperOpen(attrs),
          '<div class="wp-block-media-text__content">',
          ...innerBlocks.map(() => null),
          "</div>",
          mediaTextMediaFigureHtml(attrs),
          "</div>"
        ]
      : [
          mediaTextWrapperOpen(attrs),
          mediaTextMediaFigureHtml(attrs),
          '<div class="wp-block-media-text__content">',
          ...innerBlocks.map(() => null),
          "</div>",
          "</div>"
        ];

  return {
    ...block,
    attrs,
    innerHTML: html,
    innerContent
  };
}

async function resolveBlockImages(
  blocks: unknown[],
  requestText: string
): Promise<{ blocks: unknown[]; changed: boolean; warnings: string[] }> {
  let changed = false;
  const warnings: string[] = [];

  const visit = async (value: unknown): Promise<unknown> => {
    const block = objectValue(value);
    if (Object.keys(block).length === 0) {
      return value;
    }

    const nextBlock: Record<string, unknown> = { ...block };
    if (Array.isArray(block.innerBlocks)) {
      nextBlock.innerBlocks = await Promise.all(block.innerBlocks.map(visit));
    }

    const blockName =
      typeof block.blockName === "string" ? block.blockName.trim() : "";
    if (blockName === "core/image") {
      const attrs = objectValue(block.attrs);
      const resolved = await resolveExternalImageReference({
        currentUrl:
          typeof attrs.url === "string"
            ? attrs.url
            : typeof attrs.src === "string"
              ? attrs.src
              : null,
        altText: typeof attrs.alt === "string" ? attrs.alt : null,
        requestText
      });
      if (!resolved) {
        warnings.push("Could not source a verified image URL for a core/image block.");
        return nextBlock;
      }
      changed = true;
      return rewriteImageBlock(nextBlock, resolved.url);
    }

    if (blockName === "core/media-text") {
      const attrs = objectValue(block.attrs);
      const resolved = await resolveExternalImageReference({
        currentUrl: typeof attrs.mediaUrl === "string" ? attrs.mediaUrl : null,
        altText:
          typeof attrs.mediaAlt === "string"
            ? attrs.mediaAlt
            : typeof attrs.alt === "string"
              ? attrs.alt
              : stripHtmlToText(
                  Array.isArray(nextBlock.innerBlocks)
                    ? nextBlock.innerBlocks
                        .map((innerBlock) => {
                          const record = objectValue(innerBlock);
                          return typeof record.innerHTML === "string"
                            ? record.innerHTML
                            : "";
                        })
                        .join(" ")
                    : ""
                ),
        requestText
      });
      if (!resolved) {
        warnings.push(
          "Could not source a verified image URL for a core/media-text block."
        );
        return nextBlock;
      }
      changed = true;
      return rewriteMediaTextBlock(nextBlock, resolved.url);
    }

    return nextBlock;
  };

  return {
    blocks: await Promise.all(blocks.map(visit)),
    changed,
    warnings
  };
}

async function resolveSerializedImageContent(
  content: string,
  requestText: string
): Promise<{ content: string; changed: boolean; warnings: string[] }> {
  let changed = false;
  const warnings: string[] = [];
  let nextContent = content;

  const imageBlockPattern =
    /<!--\s*wp:image(?:\s+({[\s\S]*?}))?\s*-->([\s\S]*?)<!--\s*\/wp:image\s*-->/gi;
  const imageMatches = [...nextContent.matchAll(imageBlockPattern)];
  for (const match of imageMatches) {
    const full = match[0];
    const attrsJson = match[1];
    const innerHtml = match[2] ?? "";
    let attrs: Record<string, unknown> = {};
    if (typeof attrsJson === "string" && attrsJson.trim().length > 0) {
      try {
        attrs = objectValue(JSON.parse(attrsJson) as unknown);
      } catch {
        attrs = {};
      }
    }

    const srcMatch = /<img\b[^>]*\bsrc=(["'])(.*?)\1/i.exec(innerHtml);
    const altMatch = /<img\b[^>]*\balt=(["'])(.*?)\1/i.exec(innerHtml);
    const resolved = await resolveExternalImageReference({
      currentUrl:
        typeof attrs.url === "string"
          ? attrs.url
          : typeof attrs.src === "string"
            ? attrs.src
            : srcMatch?.[2] ?? null,
      altText:
        typeof attrs.alt === "string" ? attrs.alt : altMatch?.[2] ?? null,
      requestText
    });
    if (!resolved) {
      warnings.push(
        "Could not source a verified image URL for a serialized wp:image block."
      );
      continue;
    }

    changed = true;
    const nextAttrs = {
      ...attrs,
      id: typeof attrs.id === "number" ? attrs.id : 0,
      url: resolved.url,
      ...(typeof attrs.src === "string" ? { src: resolved.url } : {})
    };
    const html = imageBlockHtml(nextAttrs);
    const replacement = `<!-- wp:image ${JSON.stringify(nextAttrs)} -->${html}<!-- /wp:image -->`;
    nextContent = nextContent.replace(full, replacement);
  }

  const mediaTextPattern =
    /<!--\s*wp:media-text(?:\s+({[\s\S]*?}))?\s*-->([\s\S]*?)<!--\s*\/wp:media-text\s*-->/gi;
  const mediaMatches = [...nextContent.matchAll(mediaTextPattern)];
  for (const match of mediaMatches) {
    const full = match[0];
    const attrsJson = match[1];
    const innerHtml = match[2] ?? "";
    let attrs: Record<string, unknown> = {};
    if (typeof attrsJson === "string" && attrsJson.trim().length > 0) {
      try {
        attrs = objectValue(JSON.parse(attrsJson) as unknown);
      } catch {
        attrs = {};
      }
    }

    const srcMatch = /<img\b[^>]*\bsrc=(["'])(.*?)\1/i.exec(innerHtml);
    const altMatch = /<img\b[^>]*\balt=(["'])(.*?)\1/i.exec(innerHtml);
    const contentMatch =
      /<div class="wp-block-media-text__content">([\s\S]*?)<\/div>\s*<\/div>\s*$/i.exec(
        innerHtml
      ) ??
      /<div class="wp-block-media-text__content">([\s\S]*?)<\/div>/i.exec(innerHtml);
    const contentHtml = contentMatch?.[1] ?? "";

    const resolved = await resolveExternalImageReference({
      currentUrl:
        typeof attrs.mediaUrl === "string" ? attrs.mediaUrl : srcMatch?.[2] ?? null,
      altText:
        typeof attrs.mediaAlt === "string" ? attrs.mediaAlt : altMatch?.[2] ?? null,
      requestText
    });
    if (!resolved) {
      warnings.push(
        "Could not source a verified image URL for a serialized wp:media-text block."
      );
      continue;
    }

    changed = true;
    const nextAttrs = {
      ...attrs,
      mediaType: "image",
      mediaUrl: resolved.url
    };
    const html = mediaTextInnerHtml(nextAttrs, contentHtml);
    const replacement = `<!-- wp:media-text ${JSON.stringify(nextAttrs)} -->${html}<!-- /wp:media-text -->`;
    nextContent = nextContent.replace(full, replacement);
  }

  return {
    content: nextContent,
    changed,
    warnings
  };
}

function actionMayWritePostContent(type: string): boolean {
  const normalized = normalizeActionType(type);
  return (
    normalized === "create_draft_post" ||
    normalized === "create_draft_content" ||
    normalized === "create_post_draft" ||
    normalized === "sitepilot_create_draft_post" ||
    normalized === "update_post" ||
    normalized === "update_post_fields" ||
    normalized === "update_post_content" ||
    normalized === "edit_post_fields" ||
    normalized === "sitepilot_update_post_fields"
  );
}

function actionContainsImageIntent(action: Action): boolean {
  if (actionMayWritePostContent(action.type)) {
    const input = action.input as Record<string, unknown>;
    const nestedInput = objectValue(input.input);
    const scopes =
      Object.keys(nestedInput).length > 0 ? [input, nestedInput] : [input];
    return scopes.some(
      (scope) =>
        Array.isArray(scope.blocks) ||
        typeof scope.content === "string" ||
        typeof scope.postContent === "string" ||
        typeof scope.post_content === "string"
    );
  }

  const normalized = normalizeActionType(action.type);
  return (
    normalized === "set_post_featured_image" ||
    normalized === "update_post_featured_image" ||
    normalized === "set_featured_image" ||
    normalized === "sitepilot_set_post_featured_image"
  );
}

export async function sourceImagesForActionPlan(input: {
  plan: ActionPlan;
  requestText: string;
  hasAttachments: boolean;
}): Promise<ActionPlan> {
  if (input.hasAttachments) {
    return input.plan;
  }

  const requestMentionsImages = IMAGE_REQUEST_RE.test(input.requestText);
  if (!requestMentionsImages && !input.plan.proposedActions.some(actionContainsImageIntent)) {
    return input.plan;
  }

  const validationWarnings = [...input.plan.validationWarnings];
  const proposedActions = await Promise.all(
    input.plan.proposedActions.map(async (action) => {
      const normalizedType = normalizeActionType(action.type);
      const inputRecord = action.input as Record<string, unknown>;
      const nestedInput =
        inputRecord.input !== null &&
        typeof inputRecord.input === "object" &&
        !Array.isArray(inputRecord.input)
          ? (inputRecord.input as Record<string, unknown>)
          : undefined;
      const target = nestedInput ?? inputRecord;

      if (
        normalizedType === "set_post_featured_image" ||
        normalizedType === "update_post_featured_image" ||
        normalizedType === "set_featured_image" ||
        normalizedType === "sitepilot_set_post_featured_image"
      ) {
        const resolved = await resolveExternalImageReference({
          currentUrl:
            typeof target.featured_image_url === "string"
              ? target.featured_image_url
              : typeof target.featuredImageUrl === "string"
                ? target.featuredImageUrl
                : typeof target.featured_image === "string"
                  ? target.featured_image
                  : typeof target.featuredImage === "string"
                    ? target.featuredImage
                    : null,
          requestText: input.requestText
        });
        if (!resolved) {
          validationWarnings.push(
            "Could not source a verified featured image URL from the request."
          );
          return action;
        }

        const nextTarget = {
          ...target,
          featured_image_url: resolved.url
        };
        return {
          ...action,
          input:
            nestedInput !== undefined
              ? { ...inputRecord, input: nextTarget }
              : nextTarget
        };
      }

      if (!actionMayWritePostContent(action.type)) {
        return action;
      }

      if (Array.isArray(target.blocks)) {
        const resolved = await resolveBlockImages(target.blocks, input.requestText);
        validationWarnings.push(...resolved.warnings);
        if (!resolved.changed) {
          return action;
        }
        const nextTarget = {
          ...target,
          blocks: resolved.blocks
        };
        return {
          ...action,
          input:
            nestedInput !== undefined
              ? { ...inputRecord, input: nextTarget }
              : nextTarget
        };
      }

      const contentKey = (["content", "postContent", "post_content"] as const).find(
        (key) => typeof target[key] === "string"
      );
      if (!contentKey) {
        return action;
      }

      const resolved = await resolveSerializedImageContent(
        target[contentKey] as string,
        input.requestText
      );
      validationWarnings.push(...resolved.warnings);
      if (!resolved.changed) {
        return action;
      }
      const nextTarget = {
        ...target,
        [contentKey]: resolved.content
      };
      return {
        ...action,
        input:
          nestedInput !== undefined
            ? { ...inputRecord, input: nextTarget }
            : nextTarget
      };
    })
  );

  return actionPlanSchema.parse({
    ...input.plan,
    proposedActions,
    validationWarnings: [...new Set(validationWarnings)]
  });
}

export const __testables = {
  imageQueryFromContext,
  resolveSerializedImageContent,
  resolveBlockImages,
  resolveExternalImageReference,
  validateDirectImageUrl
};
