import { randomUUID } from "node:crypto";

import {
  actionPlanSchema,
  findUnsupportedParsedBlockNames,
  findUnsupportedSerializedBlockNames,
  isKnownWordPressCoreBlockName,
  type ImageAttachmentPayload,
  type Action,
  type ActionPlan,
  type PlannerContext,
  SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES
} from "@sitepilot/contracts";
import type {
  ActionId,
  ActionPlanId,
  RequestId,
  SiteId
} from "@sitepilot/domain";
import type {
  ChatContentPart,
  ChatMessage,
  ChatModelClient
} from "@sitepilot/provider-adapters";

import { extractJsonObject } from "./json-extract.js";

const PLANNER_PROMPT_VERSION = "sitepilot-plan-v4";
const ADVANCED_BLOCK_NAMES = new Set([
  "core/buttons",
  "core/columns",
  "core/cover",
  "core/embed",
  "core/gallery",
  "core/image",
  "core/media-text",
  "core/separator",
  "core/spacer",
  "core/table",
  "core/video"
]);
const HIGH_RISK_BLOCK_NAMES = new Set([
  "core/buttons",
  "core/cover",
  "core/gallery",
  "core/media-text",
  "core/table"
]);
const CONTENT_KEYS = ["content", "postContent", "post_content"] as const;
const BLOCK_KEYS = ["blocks", "contentBlocks", "content_blocks"] as const;
const MAX_PLANNER_IMAGES = 3;
const BLOCK_COMMENT_RE =
  /<!--\s*(\/?)wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+([\s\S]*?))?\s*(\/)?-->/gi;

type ContentNormalizationResult = {
  content: string;
  warnings: string[];
};

type NormalizedBlocksResult = {
  blocks: unknown[];
  warnings: string[];
};

function lastUserPlainText(context: PlannerContext): string {
  const users = context.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return last?.text?.trim() ?? "(no user message)";
}

function userCorpusForRequest(
  context: PlannerContext,
  requestId: RequestId
): string {
  const tagged = context.messages.filter(
    (m) => m.role === "user" && m.requestId === requestId
  );
  const rows =
    tagged.length > 0
      ? tagged
      : context.messages.filter((m) => m.role === "user");
  return rows
    .map((m) => m.text)
    .join("\n")
    .trim();
}

function imagePartsForRequest(
  attachments: ImageAttachmentPayload[] | undefined
): ChatContentPart[] {
  return (attachments ?? [])
    .slice(0, MAX_PLANNER_IMAGES)
    .map((attachment) => ({
      type: "image" as const,
      mediaType: attachment.mediaType,
      dataUrl: attachment.dataUrl
    }));
}

function normalizeActionType(type: string): string {
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();
}

function actionMayWritePostContent(type: string): boolean {
  const t = normalizeActionType(type);
  return (
    t === "create_draft_post" ||
    t === "create_draft_content" ||
    t === "create_post_draft" ||
    t === "sitepilot_create_draft_post" ||
    t === "update_post" ||
    t === "update_post_fields" ||
    t === "update_post_content" ||
    t === "edit_post_fields" ||
    t === "sitepilot_update_post_fields"
  );
}

function pickContentKey(
  input: Record<string, unknown>
): (typeof CONTENT_KEYS)[number] | undefined {
  return CONTENT_KEYS.find((key) => typeof input[key] === "string");
}

function hasStructuredBlocks(input: Record<string, unknown>): boolean {
  return BLOCK_KEYS.some((key) => Array.isArray(input[key]));
}

function pickBlockKey(
  input: Record<string, unknown>
): (typeof BLOCK_KEYS)[number] | undefined {
  return BLOCK_KEYS.find((key) => Array.isArray(input[key]));
}

function pickObject(
  input: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = input[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stripHtmlToPlainText(raw: string): string[] {
  const text = raw
    .replace(BLOCK_COMMENT_RE, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6])>/gi, "\n\n")
    .replace(/<(p|div|section|article|li|ul|ol|h[1-6])\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "");

  return text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

function paragraphsToBlocks(paragraphs: string[]): string {
  return paragraphs
    .map(
      (paragraph) =>
        `<!-- wp:paragraph --><p>${escapeHtml(paragraph)}</p><!-- /wp:paragraph -->`
    )
    .join("\n");
}

function normalizeBlockName(raw: unknown): string {
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
  if (!trimmed.includes("/") && isKnownWordPressCoreBlockName(`core/${trimmed}`)) {
    return `core/${trimmed}`;
  }
  return trimmed;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function headingTagName(attrs: Record<string, unknown>): string {
  const level = typeof attrs.level === "number" ? attrs.level : 2;
  const normalized = level >= 1 && level <= 6 ? level : 2;
  return `h${normalized}`;
}

function normalizeTextChunk(
  chunk: string,
  blockName: string,
  attrs: Record<string, unknown> = {}
): string {
  if (/<[a-z][\s\S]*>/i.test(chunk)) {
    return chunk;
  }
  if (blockName === "core/paragraph") {
    return `<p>${escapeHtml(chunk)}</p>`;
  }
  if (blockName === "core/heading") {
    const tagName = headingTagName(attrs);
    return `<${tagName}>${escapeHtml(chunk)}</${tagName}>`;
  }
  return escapeHtml(chunk);
}

function extractTextContent(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function quoteHtml(attrs: Record<string, unknown>, innerHTML: string): string {
  const classNames = ["wp-block-quote"];
  const textAlign =
    typeof attrs.textAlign === "string" ? attrs.textAlign.trim() : "";
  if (textAlign.length > 0) {
    classNames.push(`has-text-align-${escapeHtml(textAlign)}`);
  }

  const citation =
    typeof attrs.citation === "string" ? attrs.citation.trim() : "";
  const body = innerHTML.includes("<blockquote")
    ? innerHTML
    : `<blockquote><p>${escapeHtml(extractTextContent(innerHTML))}</p>${
        citation.length > 0 ? `<cite>${escapeHtml(citation)}</cite>` : ""
      }</blockquote>`;
  if (body.includes("<blockquote")) {
    return body.replace(
      /<blockquote\b[^>]*>/i,
      `<blockquote class="${classNames.join(" ")}">`
    );
  }
  return body;
}

function pullquoteHtml(
  attrs: Record<string, unknown>,
  innerHTML: string
): string {
  const classNames = ["wp-block-pullquote"];
  const textAlign =
    typeof attrs.textAlign === "string" ? attrs.textAlign.trim() : "";
  if (textAlign.length > 0) {
    classNames.push(`has-text-align-${escapeHtml(textAlign)}`);
  }
  const value =
    typeof attrs.value === "string" && attrs.value.trim().length > 0
      ? attrs.value
      : extractTextContent(innerHTML);
  const citation =
    typeof attrs.citation === "string" ? attrs.citation.trim() : "";
  const cite = citation.length > 0 ? `<cite>${escapeHtml(citation)}</cite>` : "";
  return `<figure class="${classNames.join(
    " "
  )}"><blockquote><p>${escapeHtml(value)}</p>${cite}</blockquote></figure>`;
}

function codeHtml(innerHTML: string): string {
  const text = extractTextContent(innerHTML);
  return `<pre class="wp-block-code"><code>${escapeHtml(text)}</code></pre>`;
}

function preformattedHtml(innerHTML: string): string {
  const text = extractTextContent(innerHTML);
  return `<pre class="wp-block-preformatted">${escapeHtml(text)}</pre>`;
}

function verseHtml(innerHTML: string): string {
  const text = extractTextContent(innerHTML);
  return `<pre class="wp-block-verse">${escapeHtml(text)}</pre>`;
}

function separatorHtml(attrs: Record<string, unknown>): string {
  const tagName =
    typeof attrs.tagName === "string" && attrs.tagName.trim().length > 0
      ? attrs.tagName.trim()
      : "hr";
  const classNames = ["wp-block-separator"];
  const opacity =
    typeof attrs.opacity === "string" ? attrs.opacity.trim() : "alpha-channel";
  if (opacity === "css") {
    classNames.push("has-css-opacity");
  } else {
    classNames.push("has-alpha-channel-opacity");
  }
  return `<${tagName} class="${classNames.join(" ")}"/>`;
}

function buttonHtml(attrs: Record<string, unknown>, innerHTML: string): string {
  const tagName = attrs.tagName === "button" ? "button" : "a";
  const textSource =
    typeof attrs.text === "string" && attrs.text.trim().length > 0
      ? attrs.text
      : extractTextContent(innerHTML);
  const text = escapeHtml(textSource);
  const title =
    typeof attrs.title === "string" && attrs.title.trim().length > 0
      ? ` title="${escapeHtml(attrs.title)}"`
      : "";
  const target =
    tagName === "a" &&
    typeof attrs.linkTarget === "string" &&
    attrs.linkTarget.trim().length > 0
      ? ` target="${escapeHtml(attrs.linkTarget)}"`
      : "";
  const rel =
    tagName === "a" &&
    typeof attrs.rel === "string" &&
    attrs.rel.trim().length > 0
      ? ` rel="${escapeHtml(attrs.rel)}"`
      : "";
  const href =
    tagName === "a" &&
    typeof attrs.url === "string" &&
    attrs.url.trim().length > 0
      ? ` href="${escapeHtml(attrs.url)}"`
      : "";
  const type =
    tagName === "button" &&
    typeof attrs.type === "string" &&
    attrs.type.trim().length > 0
      ? ` type="${escapeHtml(attrs.type)}"`
      : tagName === "button"
        ? ' type="button"'
        : "";
  return `<div class="wp-block-button"><${tagName} class="wp-block-button__link wp-element-button"${href}${title}${target}${rel}${type}>${text}</${tagName}></div>`;
}

function validGroupTagName(attrs: Record<string, unknown>): string {
  const tagName = typeof attrs.tagName === "string" ? attrs.tagName.trim() : "";
  return new Set([
    "article",
    "aside",
    "div",
    "footer",
    "header",
    "main",
    "nav",
    "section"
  ]).has(tagName)
    ? tagName
    : "div";
}

function groupWrapperOpen(attrs: Record<string, unknown>): string {
  const tagName = validGroupTagName(attrs);
  return `<${tagName} class="wp-block-group">`;
}

function groupWrapperClose(attrs: Record<string, unknown>): string {
  return `</${validGroupTagName(attrs)}>`;
}

function detailsWrapperOpen(attrs: Record<string, unknown>): string {
  const extras: string[] = [];
  if (typeof attrs.name === "string" && attrs.name.trim().length > 0) {
    extras.push(`name="${escapeHtml(attrs.name)}"`);
  }
  if (attrs.showContent === true) {
    extras.push("open");
  }
  const summary =
    typeof attrs.summary === "string" && attrs.summary.trim().length > 0
      ? attrs.summary
      : "Details";
  return `<details class="wp-block-details"${
    extras.length > 0 ? ` ${extras.join(" ")}` : ""
  }><summary>${escapeHtml(summary)}</summary>`;
}

function tableCellHtml(
  cell: Record<string, unknown>,
  cellIndex: number
): string {
  const tag =
    typeof cell.tag === "string" &&
    (cell.tag === "td" || cell.tag === "th")
      ? cell.tag
      : "td";
  const classNames: string[] = [];
  const align = typeof cell.align === "string" ? cell.align.trim() : "";
  if (align.length > 0) {
    classNames.push(`has-text-align-${escapeHtml(align)}`);
  }
  const attrs: string[] = [];
  if (classNames.length > 0) {
    attrs.push(`class="${classNames.join(" ")}"`);
  }
  if (align.length > 0) {
    attrs.push(`data-align="${escapeHtml(align)}"`);
  }
  if (
    tag === "th" &&
    typeof cell.scope === "string" &&
    cell.scope.trim().length > 0
  ) {
    attrs.push(`scope="${escapeHtml(cell.scope.trim())}"`);
  }
  if (typeof cell.colspan === "string" && cell.colspan.trim().length > 0) {
    attrs.push(`colspan="${escapeHtml(cell.colspan.trim())}"`);
  }
  if (typeof cell.rowspan === "string" && cell.rowspan.trim().length > 0) {
    attrs.push(`rowspan="${escapeHtml(cell.rowspan.trim())}"`);
  }
  const content =
    typeof cell.content === "string" && cell.content.length > 0
      ? cell.content
      : `Cell ${cellIndex + 1}`;
  return `<${tag}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>${content}</${tag}>`;
}

function tableSectionHtml(
  sectionTag: "thead" | "tbody" | "tfoot",
  rowsValue: unknown
): string {
  if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
    return "";
  }
  const rows = rowsValue
    .map((row) => {
      const rowRecord = objectValue(row);
      const cells = Array.isArray(rowRecord.cells) ? rowRecord.cells : [];
      if (cells.length === 0) {
        return "";
      }
      return `<tr>${cells
        .map((cell, cellIndex) => tableCellHtml(objectValue(cell), cellIndex))
        .join("")}</tr>`;
    })
    .filter((row) => row.length > 0)
    .join("");
  return rows.length > 0 ? `<${sectionTag}>${rows}</${sectionTag}>` : "";
}

function tableHtml(attrs: Record<string, unknown>): string {
  const head = tableSectionHtml("thead", attrs.head);
  const body = tableSectionHtml("tbody", attrs.body);
  const foot = tableSectionHtml("tfoot", attrs.foot);
  if (head.length === 0 && body.length === 0 && foot.length === 0) {
    return "";
  }
  const tableClasses: string[] = [];
  if (attrs.hasFixedLayout !== false) {
    tableClasses.push("has-fixed-layout");
  }
  const caption =
    typeof attrs.caption === "string" && attrs.caption.trim().length > 0
      ? `<figcaption class="wp-element-caption">${escapeHtml(
          attrs.caption.trim()
        )}</figcaption>`
      : "";
  return `<figure class="wp-block-table"><table${
    tableClasses.length > 0 ? ` class="${tableClasses.join(" ")}"` : ""
  }>${head}${body}${foot}</table>${caption}</figure>`;
}

function mediaTextMediaFigureHtml(attrs: Record<string, unknown>): string {
  const mediaType = typeof attrs.mediaType === "string" ? attrs.mediaType : "";
  const mediaUrl =
    typeof attrs.mediaUrl === "string" ? attrs.mediaUrl.trim() : "";
  if (mediaUrl.length === 0 || (mediaType !== "image" && mediaType !== "video")) {
    return '<figure class="wp-block-media-text__media"></figure>';
  }

  const inner =
    mediaType === "video"
      ? `<video controls src="${escapeHtml(mediaUrl)}"></video>`
      : (() => {
          const mediaAlt =
            typeof attrs.mediaAlt === "string" ? attrs.mediaAlt : "";
          const mediaId =
            typeof attrs.mediaId === "number" ? attrs.mediaId : undefined;
          const mediaSizeSlug =
            typeof attrs.mediaSizeSlug === "string" &&
            attrs.mediaSizeSlug.trim().length > 0
              ? attrs.mediaSizeSlug.trim()
              : "full";
          const classes: string[] = [];
          if (mediaId && mediaId > 0) {
            classes.push(`wp-image-${mediaId}`);
            classes.push(`size-${escapeHtml(mediaSizeSlug)}`);
          }
          let style = "";
          if (attrs.imageFill === true) {
            const focalPoint =
              typeof attrs.focalPoint === "object" && attrs.focalPoint !== null
                ? (attrs.focalPoint as Record<string, unknown>)
                : {};
            const x = typeof focalPoint.x === "number" ? focalPoint.x : 0.5;
            const y = typeof focalPoint.y === "number" ? focalPoint.y : 0.5;
            style = ` style="object-position:${Math.round(
              x * 100
            )}% ${Math.round(y * 100)}%"`;
          }
          const img = `<img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(
            mediaAlt
          )}"${
            classes.length > 0 ? ` class="${classes.join(" ")}"` : ""
          }${style}/>`;
          if (
            typeof attrs.href === "string" &&
            attrs.href.trim().length > 0
          ) {
            const target =
              typeof attrs.linkTarget === "string" &&
              attrs.linkTarget.trim().length > 0
                ? ` target="${escapeHtml(attrs.linkTarget.trim())}"`
                : "";
            const rel =
              typeof attrs.rel === "string" && attrs.rel.trim().length > 0
                ? ` rel="${escapeHtml(attrs.rel.trim())}"`
                : "";
            const linkClass =
              typeof attrs.linkClass === "string" &&
              attrs.linkClass.trim().length > 0
                ? ` class="${escapeHtml(attrs.linkClass.trim())}"`
                : "";
            return `<a${linkClass} href="${escapeHtml(
              attrs.href.trim()
            )}"${target}${rel}>${img}</a>`;
          }
          return img;
        })();
  return `<figure class="wp-block-media-text__media">${inner}</figure>`;
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

function listWrapperOpen(attrs: Record<string, unknown>): string {
  const ordered = attrs.ordered === true;
  const tagName = ordered ? "ol" : "ul";
  const extras: string[] = [];
  if (ordered && attrs.reversed === true) {
    extras.push("reversed");
  }
  if (ordered && typeof attrs.start === "number" && Number.isFinite(attrs.start)) {
    extras.push(`start="${String(attrs.start)}"`);
  }
  return `<${tagName} class="wp-block-list"${extras.length > 0 ? ` ${extras.join(" ")}` : ""}>`;
}

function listWrapperClose(attrs: Record<string, unknown>): string {
  return attrs.ordered === true ? "</ol>" : "</ul>";
}

function listItemHtml(innerHTML: string): string {
  if (innerHTML.includes("<li")) {
    return innerHTML.replace(/<li\b[^>]*>/i, "<li>");
  }
  return `<li>${escapeHtml(extractTextContent(innerHTML))}</li>`;
}

function imageHtml(attrs: Record<string, unknown>): string {
  const url = typeof attrs.url === "string" ? attrs.url : "";
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  if (url.length === 0) {
    return "";
  }
  const sizeSlug = typeof attrs.sizeSlug === "string" ? attrs.sizeSlug : "";
  const id = typeof attrs.id === "number" ? attrs.id : undefined;
  const figureClasses = ["wp-block-image"];
  if (sizeSlug.length > 0) {
    figureClasses.push(`size-${escapeHtml(sizeSlug)}`);
  }
  const imageClass = id !== undefined && id > 0 ? ` class="wp-image-${id}"` : "";
  return `<figure class="${figureClasses.join(" ")}"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${imageClass}/></figure>`;
}

function spacerHtml(attrs: Record<string, unknown>): string {
  const rawHeight =
    typeof attrs.height === "number"
      ? String(attrs.height)
      : typeof attrs.height === "string"
        ? attrs.height
        : "100px";
  const height = /^\d+$/.test(rawHeight) ? `${rawHeight}px` : rawHeight;
  if (height !== "100px") {
    attrs.height = height;
  } else {
    delete attrs.height;
  }
  return `<div style="height:${escapeHtml(height)}" aria-hidden="true" class="wp-block-spacer"></div>`;
}

function columnWrapperOpen(attrs: Record<string, unknown>): string {
  const width = typeof attrs.width === "string" ? attrs.width.trim() : "";
  const style = width.length > 0 ? ` style="flex-basis:${escapeHtml(width)}"` : "";
  return `<div class="wp-block-column"${style}>`;
}

function canonicalContainerInnerContent(
  blockName: string,
  attrs: Record<string, unknown>,
  innerBlocks: unknown[]
): string[] | null[] | Array<string | null> | null {
  if (blockName === "core/columns") {
    return [
      '<div class="wp-block-columns">',
      ...innerBlocks.flatMap((_, index) =>
        index === 0 ? [null] : ["\n\n", null]
      ),
      "</div>"
    ];
  }

  if (blockName === "core/column") {
    return [columnWrapperOpen(attrs), ...innerBlocks.map(() => null), "</div>"];
  }

  if (blockName === "core/buttons") {
    return [
      '<div class="wp-block-buttons">',
      ...innerBlocks.flatMap((_, index) =>
        index === 0 ? [null] : ["\n\n", null]
      ),
      "</div>"
    ];
  }

  if (blockName === "core/group") {
    return [
      groupWrapperOpen(attrs),
      ...innerBlocks.map(() => null),
      groupWrapperClose(attrs)
    ];
  }

  if (blockName === "core/details") {
    return [
      detailsWrapperOpen(attrs),
      ...innerBlocks.map(() => null),
      "</details>"
    ];
  }

  if (blockName === "core/media-text") {
    const mediaFigure = mediaTextMediaFigureHtml(attrs);
    const contentOpen = '<div class="wp-block-media-text__content">';
    if (attrs.mediaPosition === "right") {
      return [
        mediaTextWrapperOpen(attrs),
        contentOpen,
        ...innerBlocks.map(() => null),
        "</div>",
        mediaFigure,
        "</div>"
      ];
    }
    return [
      mediaTextWrapperOpen(attrs),
      mediaFigure,
      contentOpen,
      ...innerBlocks.map(() => null),
      "</div>",
      "</div>"
    ];
  }

  if (blockName === "core/list") {
    return [listWrapperOpen(attrs), ...innerBlocks.map(() => null), listWrapperClose(attrs)];
  }

  return null;
}

function normalizeParsedBlockNode(
  value: unknown,
  path: string,
  warnings: string[]
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Dropped malformed block at ${path}.`);
    return null;
  }

  const raw = value as Record<string, unknown>;
  const blockName = normalizeBlockName(raw.blockName);
  if (blockName.length === 0) {
    warnings.push(`Dropped block at ${path} because blockName is missing.`);
    return null;
  }

  const attrs = objectValue(raw.attrs);
  const innerBlocks = Array.isArray(raw.innerBlocks)
    ? raw.innerBlocks
        .map((inner, index) =>
          normalizeParsedBlockNode(
            inner,
            `${path}.innerBlocks[${index}]`,
            warnings
          )
        )
        .filter((block): block is Record<string, unknown> => block !== null)
    : [];

  let innerHTML = typeof raw.innerHTML === "string" ? raw.innerHTML : "";
  let innerContent = Array.isArray(raw.innerContent)
    ? raw.innerContent.map((chunk) =>
        typeof chunk === "string"
          ? normalizeTextChunk(chunk, blockName, attrs)
          : null
      )
    : [];

  if (innerHTML.length === 0 && innerContent.length > 0) {
    innerHTML = innerContent.filter((chunk) => chunk !== null).join("");
  }

  if (
    (blockName === "core/paragraph" || blockName === "core/heading") &&
    innerHTML.length > 0
  ) {
    innerHTML = normalizeTextChunk(innerHTML, blockName, attrs);
    innerContent = [innerHTML];
  }

  if (blockName === "core/button") {
    innerHTML = buttonHtml(attrs, innerHTML);
    innerContent = [innerHTML];
  }

  if (blockName === "core/pullquote") {
    innerHTML = pullquoteHtml(attrs, innerHTML);
    innerContent = [innerHTML];
  }

  if (blockName === "core/code") {
    innerHTML = codeHtml(innerHTML);
    innerContent = [innerHTML];
  }

  if (blockName === "core/preformatted") {
    innerHTML = preformattedHtml(innerHTML);
    innerContent = [innerHTML];
  }

  if (blockName === "core/quote") {
    innerHTML = quoteHtml(attrs, innerHTML);
    innerContent = [innerHTML];
  }

  if (blockName === "core/separator") {
    innerHTML = separatorHtml(attrs);
    innerContent = [innerHTML];
  }

  if (blockName === "core/table") {
    innerHTML = tableHtml(attrs);
    innerContent = innerHTML.length > 0 ? [innerHTML] : [];
  }

  if (blockName === "core/list-item") {
    innerHTML = listItemHtml(innerHTML);
    innerContent = [innerHTML];
  }

  if (blockName === "core/image") {
    const generated = imageHtml(attrs);
    if (generated.length > 0) {
      innerHTML = generated;
      innerContent = [generated];
    } else if (innerHTML.length > 0 && innerContent.length === 0) {
      innerContent = [innerHTML];
    }
  }

  if (blockName === "core/spacer") {
    innerHTML = spacerHtml(attrs);
    innerContent = [innerHTML];
  }

  if (blockName === "core/verse") {
    innerHTML = verseHtml(innerHTML);
    innerContent = [innerHTML];
  }

  const containerInnerContent = canonicalContainerInnerContent(
    blockName,
    attrs,
    innerBlocks
  );
  if (containerInnerContent !== null) {
    innerContent = containerInnerContent;
    innerHTML = innerContent.filter((chunk) => chunk !== null).join("");
  }

  if (innerBlocks.length > 0 && innerContent.length === 0) {
    innerContent = innerBlocks.map(() => null);
  }

  if (raw.blockName !== blockName) {
    warnings.push(`Normalized blockName at ${path} from "${String(raw.blockName)}" to "${blockName}".`);
  }

  if (typeof raw.innerHTML !== "string") {
    warnings.push(`Filled missing innerHTML for ${blockName} at ${path}.`);
  }

  return {
    blockName,
    attrs,
    innerBlocks,
    innerHTML,
    innerContent
  };
}

function normalizeParsedBlocks(rawBlocks: unknown[]): NormalizedBlocksResult {
  const warnings: string[] = [];
  const blocks = rawBlocks
    .map((block, index) =>
      normalizeParsedBlockNode(block, `blocks[${index}]`, warnings)
    )
    .filter((block): block is Record<string, unknown> => block !== null);

  return { blocks, warnings };
}

function requestAllowsAdvancedBlocks(requestText: string): boolean {
  return /\b(image|images|photo|photos|headshot|headshots|gallery|media|left\/right|left-right|alternating|alternates|columns?|column|side[- ]by[- ]side|button|cta|cover|embed|video|table|separator|spacer)\b/i.test(
    requestText
  );
}

function findAdvancedBlockNames(content: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  BLOCK_COMMENT_RE.lastIndex = 0;
  while ((match = BLOCK_COMMENT_RE.exec(content)) !== null) {
    const rawBlockName = match[2];
    if (rawBlockName === undefined) {
      continue;
    }
    if (match[1] === "/") {
      continue;
    }
    const blockName = `core/${rawBlockName}`;
    if (ADVANCED_BLOCK_NAMES.has(blockName)) {
      found.add(blockName);
    }
  }
  return [...found];
}

function findHighRiskBlockNames(content: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  BLOCK_COMMENT_RE.lastIndex = 0;
  while ((match = BLOCK_COMMENT_RE.exec(content)) !== null) {
    const rawBlockName = match[2];
    if (rawBlockName === undefined || match[1] === "/") {
      continue;
    }
    const blockName = `core/${rawBlockName}`;
    if (HIGH_RISK_BLOCK_NAMES.has(blockName)) {
      found.add(blockName);
    }
  }
  return [...found];
}

function validateBlockSerialization(content: string): string[] {
  const issues: string[] = [];
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  BLOCK_COMMENT_RE.lastIndex = 0;

  while ((match = BLOCK_COMMENT_RE.exec(content)) !== null) {
    const isClosing = match[1] === "/";
    const blockName = match[2];
    if (blockName === undefined) {
      continue;
    }
    const attrs = match[3]?.trim();
    const isSelfClosing = match[4] === "/";

    if (isClosing) {
      const open = stack.pop();
      if (open !== blockName) {
        issues.push(
          `mismatched block delimiter: expected closing tag for "${open ?? "none"}" but found "${blockName}"`
        );
      }
      continue;
    }

    if (attrs !== undefined && attrs.length > 0) {
      try {
        JSON.parse(attrs);
      } catch {
        issues.push(`invalid block attrs JSON for "${blockName}"`);
      }
    }

    if (!isSelfClosing) {
      stack.push(blockName);
    }
  }

  if (stack.length > 0) {
    issues.push(
      `unclosed block delimiters remain: ${stack.map((name) => `"${name}"`).join(", ")}`
    );
  }

  return issues;
}

function normalizePostContent(
  rawContent: string,
  requestText: string
): ContentNormalizationResult {
  const content = rawContent.trim();
  if (content.length === 0) {
    return { content: rawContent, warnings: [] };
  }

  if (!content.includes("<!-- wp:")) {
    const paragraphs = stripHtmlToPlainText(content);
    if (paragraphs.length === 0) {
      return { content: rawContent, warnings: [] };
    }
    return {
      content: paragraphsToBlocks(paragraphs),
      warnings: [
        "Planner returned post content without Gutenberg block serialization; normalized it into paragraph blocks."
      ]
    };
  }

  const warnings: string[] = [];
  const highRiskBlocks = findHighRiskBlockNames(content);
  if (highRiskBlocks.length > 0) {
    const paragraphs = stripHtmlToPlainText(content);
    if (paragraphs.length > 0) {
      return {
        content: paragraphsToBlocks(paragraphs),
        warnings: [
          `Planner used high-risk Gutenberg block types (${highRiskBlocks.join(", ")}); normalized content to paragraph blocks to avoid editor recovery.`
        ]
      };
    }
    warnings.push(
      `Planner used high-risk Gutenberg block types (${highRiskBlocks.join(", ")}), which commonly break serialization.`
    );
  }

  const serializationIssues = validateBlockSerialization(content);
  if (serializationIssues.length > 0) {
    const paragraphs = stripHtmlToPlainText(content);
    if (paragraphs.length > 0) {
      return {
        content: paragraphsToBlocks(paragraphs),
        warnings: [
          `Planner returned malformed Gutenberg block serialization (${serializationIssues.join("; ")}); fell back to paragraph blocks.`
        ]
      };
    }
    warnings.push(
      `Planner returned malformed Gutenberg block serialization (${serializationIssues.join("; ")}).`
    );
  }

  const advancedBlocks = findAdvancedBlockNames(content);
  if (advancedBlocks.length > 0 && !requestAllowsAdvancedBlocks(requestText)) {
    warnings.push(
      `Planner added advanced blocks not clearly requested by the operator: ${advancedBlocks.join(", ")}.`
    );
  }

  if (
    /\b(placeholder|lorem ipsum|content about|section about|bio goes here|insert image|alternating blocks)\b/i.test(
      content
    )
  ) {
    warnings.push(
      "Planner content still contains placeholder or meta-descriptive copy instead of final user-facing copy."
    );
  }

  return { content: rawContent, warnings };
}

function normalizePlanPostContent(
  plan: ActionPlan,
  requestText: string
): ActionPlan {
  const validationWarnings = [...plan.validationWarnings];
  const proposedActions = plan.proposedActions.map((action) => {
    if (!actionMayWritePostContent(action.type)) {
      return action;
    }

    const input = action.input as Record<string, unknown>;
    const nestedInput = pickObject(input, "input");
    const blockTarget = nestedInput ?? input;
    const blockKey = pickBlockKey(blockTarget);
    if (blockKey !== undefined && Array.isArray(blockTarget[blockKey])) {
      const normalizedBlocks = normalizeParsedBlocks(blockTarget[blockKey]);
      validationWarnings.push(...normalizedBlocks.warnings);
      const unsupportedBlocks = findUnsupportedParsedBlockNames(
        normalizedBlocks.blocks
      );
      if (unsupportedBlocks.length > 0) {
        validationWarnings.push(
          `Structured parsed blocks include unsupported block types that execution will reject: ${unsupportedBlocks.join(", ")}. Supported blocks today: ${SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES.join(", ")}.`
        );
      }
      const nextBlockTarget = {
        ...blockTarget,
        [blockKey]: normalizedBlocks.blocks
      };
      return {
        ...action,
        input:
          nestedInput !== undefined
            ? {
                ...input,
                input: nextBlockTarget
              }
            : nextBlockTarget
      } satisfies Action;
    }

    if (hasStructuredBlocks(input)) {
      return action;
    }

    const contentKey = pickContentKey(input);
    if (contentKey === undefined) {
      return action;
    }

    const currentContent = input[contentKey];
    if (typeof currentContent !== "string") {
      return action;
    }

    const normalized = normalizePostContent(currentContent, requestText);
    validationWarnings.push(...normalized.warnings);
    const unsupportedSerializedBlocks = findUnsupportedSerializedBlockNames(
      normalized.content
    );
    if (unsupportedSerializedBlocks.length > 0) {
      validationWarnings.push(
        `Serialized Gutenberg content includes unsupported block types that execution will reject: ${unsupportedSerializedBlocks.join(", ")}. Supported blocks today: ${SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES.join(", ")}.`
      );
    }
    if (normalized.content === currentContent) {
      return action;
    }

    return {
      ...action,
      input: {
        ...input,
        [contentKey]: normalized.content
      }
    } satisfies Action;
  });

  return actionPlanSchema.parse({
    ...plan,
    proposedActions,
    validationWarnings: [...new Set(validationWarnings)]
  });
}

export function buildStubActionPlan(input: {
  context: PlannerContext;
  requestId: RequestId;
  siteId: SiteId;
  nowIso: string;
}): ActionPlan {
  const summary = lastUserPlainText(input.context);
  const planId = randomUUID() as ActionPlanId;
  const interpretId = randomUUID() as ActionId;
  const draftPostId = randomUUID() as ActionId;
  const draftTitle =
    summary.length > 80
      ? `Draft: ${summary.slice(0, 77)}…`
      : `Draft: ${summary}`;

  const draft: ActionPlan = {
    id: planId,
    requestId: input.requestId,
    siteId: input.siteId,
    requestSummary: summary.slice(0, 500),
    assumptions: [
      "Stub planner: no provider API key configured; this plan is a deterministic placeholder."
    ],
    openQuestions: [],
    targetEntities: [],
    proposedActions: [
      {
        id: interpretId,
        type: "interpret_request",
        version: 1,
        input: { summary },
        targetEntityRefs: [],
        permissionRequirement: "read_site",
        riskLevel: "low",
        dryRunCapable: true,
        rollbackSupported: true
      },
      {
        id: draftPostId,
        type: "create_draft_post",
        version: 1,
        input: {
          title: draftTitle,
          content: summary,
          post_type: "post"
        },
        targetEntityRefs: [],
        permissionRequirement: "edit_posts",
        riskLevel: "low",
        dryRunCapable: true,
        rollbackSupported: false
      }
    ],
    dependencies: [],
    approvalRequired: false,
    riskLevel: "low",
    rollbackNotes: [],
    validationWarnings: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };

  return actionPlanSchema.parse(draft);
}

export async function buildLlmActionPlan(input: {
  context: PlannerContext;
  requestId: RequestId;
  siteId: SiteId;
  nowIso: string;
  requestAttachments?: ImageAttachmentPayload[];
  client: ChatModelClient;
  model: string;
}): Promise<{
  plan: ActionPlan;
  usage: { inputTokens: number; outputTokens: number; provider: string };
}> {
  const system = `You are SitePilot's planning engine. Reply with a single JSON object only (no markdown) that matches this shape:
{
  "requestSummary": string (non-empty),
  "assumptions": string[],
  "openQuestions": string[],
  "targetEntities": string[],
  "proposedActions": [{
    "id": string (unique id),
    "type": string (machine-readable action type),
    "version": positive int,
    "input": object (string keys to JSON values),
    "targetEntityRefs": string[],
    "permissionRequirement": string,
    "riskLevel": "low"|"medium"|"high"|"critical",
    "dryRunCapable": boolean,
    "rollbackSupported": boolean
  }] (at least one),
  "dependencies": string[],
  "approvalRequired": boolean,
  "riskLevel": "low"|"medium"|"high"|"critical",
  "rollbackNotes": string[],
  "validationWarnings": string[]
}
Use the operator request and site context. Keep actions conservative.
If plannerContext.activeSkills is present, treat each skill's instructions as active additional constraints for this plan only.
Use targetSummaries and priorChanges. If the thread already created a post or page and a later request is clearly modifying that same content, reuse that known entity and include its identifier such as post_id in the action input.
If an exact post_id is not known but the target can be uniquely discovered at execution time, include lookup fields such as lookup_status, lookup_slug, lookup_title, lookup_search, and lookup_post_type in the update action input (same object as post_id would use). Example: {"type":"update_post_fields","input":{"lookup_title":"Hello Matt","lookup_status":"draft","content":"..."}}.
Do not propose update actions that lack both a concrete post_id and resolvable lookup fields.
Do not invent deliverables, sections, media, layouts, or block types the operator did not ask for. Default to the smallest faithful set of blocks, usually headings, paragraphs, and lists only. Do not add image/media-text/columns/gallery/buttons/cover/separator/spacer/embed/table/video blocks unless the request explicitly requires them.
For each proposed action, put tool arguments directly in the action.input object. Do not wrap tool arguments in a nested input object inside action.input.
For content-writing actions, use structured block data instead of hand-written serialized HTML whenever the request needs nested, layout, media, spacer, columns, gallery, cover, or other non-trivial Gutenberg blocks. Use input.blocks as an array of WordPress parsed block objects that can be passed to WordPress serialize_blocks(): each block has blockName, attrs, innerBlocks, innerHTML, and innerContent. Parsed blockName values for WordPress core blocks must use the "core/name" form such as "core/columns", "core/column", "core/paragraph", "core/image", and "core/spacer"; never use comment prefixes such as "wp:columns" in parsed blockName. Use input.content only for simple text-only block markup when no nested layout, media, or spacer block is needed. If input.blocks is present, it is the authoritative post body and downstream tools will prefer it over input.content.
Only use parsed Gutenberg blocks that SitePilot explicitly supports for execution right now: ${SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES.join(", ")}. If the request would require any other block, do not invent it. Use simpler supported blocks where faithful, otherwise surface the limitation in validationWarnings.

WordPress Gutenberg content rules for create_draft_post and update_post_fields (post_content / content field):
- Store body content as block serialization: each block uses delimiters <!-- wp:blockname {json attrs} --> ...inner HTML... <!-- /wp:blockname -->. Do not wrap the whole article in a single wp:html block that only describes intent (e.g. never use placeholder text like "Content about X with alternating blocks").
- Write full copy the user asked for in wp:paragraph blocks (or headings where appropriate). When the user requests photos or headshots, you MUST include wp:image blocks with real, public https:// URLs (for example direct Wikimedia Commons file URLs on upload.wikimedia.org). Use "id":0 in the block JSON when the file is not yet in the Media Library; include the same URL in the block attrs and in the <img src="...">.
- For nested/layout/media/spacer/columns blocks, use input.blocks so WordPress can serialize the parsed block tree. Do not improvise saved HTML for these block types.
- Every opening block delimiter must have the correct matching closing delimiter, in the correct nesting order. Block attrs must be valid JSON. Do not emit malformed or partially-open blocks.
- Do not output planning notes, placeholder labels, or descriptions of intended blocks inside the post content. Output only the final user-facing content.
- The content value is embedded inside JSON: escape double quotes and newlines in the serialized blocks so the overall planner output remains valid JSON.`;

  const user = JSON.stringify(
    {
      plannerContext: input.context,
      requestId: input.requestId,
      siteId: input.siteId,
      promptVersion: PLANNER_PROMPT_VERSION
    },
    null,
    2
  );

  const userContent: ChatMessage["content"] = [
    { type: "text", text: user },
    ...imagePartsForRequest(input.requestAttachments)
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userContent }
  ];

  const result = await input.client.complete(messages, input.model);
  const raw = extractJsonObject(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Planner model returned non-JSON output.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Planner model JSON must be an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const planId = randomUUID() as ActionPlanId;
  const merged = {
    ...obj,
    id: planId,
    requestId: input.requestId,
    siteId: input.siteId,
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };

  const parsedPlan = actionPlanSchema.parse(merged);
  const plan = normalizePlanPostContent(
    parsedPlan,
    userCorpusForRequest(input.context, input.requestId)
  );

  return {
    plan,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      provider: input.client.providerId
    }
  };
}
