export const WORDPRESS_CORE_BLOCK_REFERENCE_URL =
  "https://developer.wordpress.org/block-editor/reference-guides/core-blocks/";

export const ALL_WORDPRESS_CORE_BLOCK_NAMES = [
  "core/accordion",
  "core/accordion-heading",
  "core/accordion-item",
  "core/accordion-panel",
  "core/archives",
  "core/audio",
  "core/avatar",
  "core/block",
  "core/breadcrumbs",
  "core/button",
  "core/buttons",
  "core/calendar",
  "core/categories",
  "core/code",
  "core/column",
  "core/columns",
  "core/comment-author-avatar",
  "core/comment-author-name",
  "core/comment-content",
  "core/comment-date",
  "core/comment-edit-link",
  "core/comment-reply-link",
  "core/comment-template",
  "core/comments",
  "core/comments-pagination",
  "core/comments-pagination-next",
  "core/comments-pagination-numbers",
  "core/comments-pagination-previous",
  "core/comments-title",
  "core/cover",
  "core/details",
  "core/embed",
  "core/file",
  "core/footnotes",
  "core/form",
  "core/form-input",
  "core/form-submission-notification",
  "core/form-submit-button",
  "core/freeform",
  "core/gallery",
  "core/group",
  "core/heading",
  "core/home-link",
  "core/html",
  "core/icon",
  "core/image",
  "core/latest-comments",
  "core/latest-posts",
  "core/list",
  "core/list-item",
  "core/loginout",
  "core/math",
  "core/media-text",
  "core/missing",
  "core/more",
  "core/navigation",
  "core/navigation-link",
  "core/navigation-overlay-close",
  "core/navigation-submenu",
  "core/nextpage",
  "core/page-list",
  "core/page-list-item",
  "core/paragraph",
  "core/pattern",
  "core/playlist",
  "core/playlist-track",
  "core/post-author",
  "core/post-author-biography",
  "core/post-author-name",
  "core/post-comment",
  "core/post-comments-count",
  "core/post-comments-form",
  "core/post-comments-link",
  "core/post-content",
  "core/post-date",
  "core/post-excerpt",
  "core/post-featured-image",
  "core/post-navigation-link",
  "core/post-template",
  "core/post-terms",
  "core/post-time-to-read",
  "core/post-title",
  "core/preformatted",
  "core/pullquote",
  "core/query",
  "core/query-no-results",
  "core/query-pagination",
  "core/query-pagination-next",
  "core/query-pagination-numbers",
  "core/query-pagination-previous",
  "core/query-title",
  "core/query-total",
  "core/quote",
  "core/read-more",
  "core/rss",
  "core/search",
  "core/separator",
  "core/shortcode",
  "core/site-logo",
  "core/site-tagline",
  "core/site-title",
  "core/social-link",
  "core/social-links",
  "core/spacer",
  "core/tab",
  "core/tab-list",
  "core/tab-panel",
  "core/tab-panels",
  "core/table",
  "core/table-of-contents",
  "core/tabs",
  "core/tag-cloud",
  "core/template-part",
  "core/term-count",
  "core/term-description",
  "core/term-name",
  "core/term-template",
  "core/terms-query",
  "core/text-columns",
  "core/verse",
  "core/video"
] as const;

export const SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES = [
  "core/button",
  "core/buttons",
  "core/code",
  "core/column",
  "core/columns",
  "core/details",
  "core/group",
  "core/heading",
  "core/image",
  "core/list",
  "core/list-item",
  "core/media-text",
  "core/paragraph",
  "core/preformatted",
  "core/pullquote",
  "core/quote",
  "core/separator",
  "core/spacer",
  "core/table",
  "core/verse"
] as const;

export type CoreBlockSupportStatus = "supported" | "unsupported";

export type CoreBlockSupportEntry = {
  name: string;
  label: string;
  status: CoreBlockSupportStatus;
  reason: string;
  sourceUrl: string;
};

export type IndexedCoreBlockEntry = {
  name: string;
  label: string;
  title: string;
  executable: boolean;
  status: "executable" | "indexed";
  reason: string;
  metadataPath: string;
  canContainInnerBlocks: boolean;
  likelyUsesInnerBlocks: boolean;
  hasParentRestriction: boolean;
  hasAncestorRestriction: boolean;
  renderPath?: string;
  phpRegistrationPath?: string;
  apiVersion?: number;
  category?: string;
  parent: string[];
  ancestor: string[];
  allowedBlocks: string[];
  attributes: string[];
  supports: string[];
  styleFiles: string[];
};

export type WordPressCoreBlockIndex = {
  sourceRoot: string;
  cachePath: string;
  generatedAt: string;
  wordpressVersion: string | null;
  indexedBlockCount: number;
  executableBlockCount: number;
  missingReferenceBlocks: string[];
  additionalSnapshotBlocks: string[];
  blocks: IndexedCoreBlockEntry[];
};

const WORDPRESS_CORE_BLOCK_NAME_SET = new Set<string>(
  ALL_WORDPRESS_CORE_BLOCK_NAMES
);
const SUPPORTED_WORDPRESS_CORE_BLOCK_NAME_SET = new Set<string>(
  SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES
);

function blockLabel(name: string): string {
  const slug = name.startsWith("core/") ? name.slice("core/".length) : name;
  return slug
    .split("-")
    .map((segment) =>
      segment.length > 0
        ? `${segment[0]!.toUpperCase()}${segment.slice(1)}`
        : segment
    )
    .join(" ");
}

export function coreBlockLabel(name: string): string {
  return blockLabel(name);
}

export const WORDPRESS_CORE_BLOCK_SUPPORT: readonly CoreBlockSupportEntry[] =
  ALL_WORDPRESS_CORE_BLOCK_NAMES.map((name) => ({
    name,
    label: blockLabel(name),
    status: SUPPORTED_WORDPRESS_CORE_BLOCK_NAME_SET.has(name)
      ? "supported"
      : "unsupported",
    reason: SUPPORTED_WORDPRESS_CORE_BLOCK_NAME_SET.has(name)
      ? "Execution is allowed because SitePilot has explicit parsed-block canonicalization for this block."
      : "Execution is blocked because SitePilot does not yet have explicit parsed-block canonicalization for this block and must not invent Gutenberg save HTML.",
    sourceUrl: WORDPRESS_CORE_BLOCK_REFERENCE_URL
  }));

export function normalizeParsedBlockName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("wp:")) {
    const name = trimmed.slice("wp:".length);
    return name.includes("/") ? name : `core/${name}`;
  }
  if (trimmed.startsWith("core:")) {
    return `core/${trimmed.slice("core:".length)}`;
  }
  if (!trimmed.includes("/") && WORDPRESS_CORE_BLOCK_NAME_SET.has(`core/${trimmed}`)) {
    return `core/${trimmed}`;
  }
  return trimmed;
}

export function isKnownWordPressCoreBlockName(name: string): boolean {
  return WORDPRESS_CORE_BLOCK_NAME_SET.has(name);
}

export function isSupportedWordPressCoreBlockName(name: string): boolean {
  return SUPPORTED_WORDPRESS_CORE_BLOCK_NAME_SET.has(name);
}

export function getWordPressCoreBlockSupport(
  rawName: unknown
): CoreBlockSupportEntry | null {
  const name = normalizeParsedBlockName(rawName);
  if (!WORDPRESS_CORE_BLOCK_NAME_SET.has(name)) {
    return null;
  }
  return (
    WORDPRESS_CORE_BLOCK_SUPPORT.find((entry) => entry.name === name) ?? null
  );
}

export function explainUnsupportedBlockName(rawName: unknown): string {
  const name = normalizeParsedBlockName(rawName);
  if (name.length === 0) {
    return "Block name is missing or invalid.";
  }
  if (WORDPRESS_CORE_BLOCK_NAME_SET.has(name)) {
    return `WordPress core block "${name}" is not supported for execution yet because SitePilot does not have explicit canonical serialization for it.`;
  }
  return `Block "${name}" is not supported for execution because it is outside SitePilot's supported WordPress core block registry.`;
}

export function findUnsupportedParsedBlockNames(blocks: unknown[]): string[] {
  const found = new Set<string>();

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const block = value as Record<string, unknown>;
    const name = normalizeParsedBlockName(block.blockName);
    if (name.length > 0) {
      if (!SUPPORTED_WORDPRESS_CORE_BLOCK_NAME_SET.has(name)) {
        found.add(name);
      }
    } else {
      found.add("(missing blockName)");
    }

    if (Array.isArray(block.innerBlocks)) {
      for (const innerBlock of block.innerBlocks) {
        visit(innerBlock);
      }
    }
  };

  for (const block of blocks) {
    visit(block);
  }

  return [...found].sort();
}

export function findUnsupportedSerializedBlockNames(content: string): string[] {
  const found = new Set<string>();
  const blockCommentPattern =
    /<!--\s*(\/?)wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+[\s\S]*?)?\s*(\/)?-->/gi;
  let match: RegExpExecArray | null;
  blockCommentPattern.lastIndex = 0;

  while ((match = blockCommentPattern.exec(content)) !== null) {
    if (match[1] === "/") {
      continue;
    }
    const rawBlockName = match[2];
    if (rawBlockName === undefined) {
      continue;
    }
    const name = normalizeParsedBlockName(`core/${rawBlockName}`);
    if (!SUPPORTED_WORDPRESS_CORE_BLOCK_NAME_SET.has(name)) {
      found.add(name);
    }
  }

  return [...found].sort();
}
