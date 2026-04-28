import { randomUUID } from "node:crypto";

import {
  explainUnsupportedBlockName,
  findUnsupportedParsedBlockNames,
  findUnsupportedSerializedBlockNames,
  siteConfigSchema,
  type ImageAttachmentPayload,
  type SiteConfig,
  SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES
} from "@sitepilot/contracts";
import {
  McpHttpClient,
  normalizeMcpToolResult
} from "@sitepilot/mcp-client";
import type {
  ActionId,
  ActionPlanId,
  AuditEntryId,
  ChatMessageId,
  ExecutionRun,
  ExecutionRunId,
  RequestId,
  SiteId,
  ToolInvocationId
} from "@sitepilot/domain";
import {
  actionToMcpToolCall,
  actionSupportsPostLookup,
  buildPostLookupArguments,
  findNumericPostId,
  canResolveActionViaPostLookup,
  resolvePostIdFromLookupResult
} from "@sitepilot/services";

import { getDatabase } from "./app-database.js";
import { DEFAULT_OPERATOR } from "./chat-service.js";
import { resolveExternalImageReference } from "./image-sourcing-service.js";
import { createMcpClientForSite } from "./site-mcp-client.js";

export type ExecutePlanActionInput = {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  actionId: ActionId;
  dryRun: boolean;
  idempotencyKey?: string;
};

export type ExecutePlanActionResult =
  | {
      ok: true;
      dryRun: boolean;
      skipped?: boolean;
      reused?: boolean;
      toolName?: string;
      mcpResult: Record<string, unknown>;
      executionRunId?: ExecutionRunId;
      toolInvocationId?: ToolInvocationId;
    }
  | { ok: false; code: string; message: string };

function nowIso(): string {
  return new Date().toISOString();
}

function defaultIdempotencyKey(input: {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  actionId: ActionId;
}): string {
  return `sitepilot:${input.siteId}:${input.requestId}:${input.planId}:${input.actionId}`;
}

function retryIdempotencyKey(baseKey: string): string {
  return `${baseKey}:retry:${randomUUID()}`;
}

function normalizeActionType(actionType: string): string {
  return actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();
}

function actionCreatesDraftPost(actionType: string): boolean {
  const t = normalizeActionType(actionType);
  return (
    t === "create_draft_post" ||
    t === "create_draft_content" ||
    t === "create_post_draft" ||
    t === "sitepilot_create_draft_post"
  );
}

function extractPostIdFromToolOutput(output: Record<string, unknown> | undefined): number | undefined {
  const postId = output?.["post_id"];
  if (typeof postId === "number" && Number.isFinite(postId) && postId > 0) {
    return postId;
  }
  return undefined;
}

function actionIsExecutable(actionType: string, input: Record<string, unknown>): boolean {
  return (
    actionToMcpToolCall(actionType, input, true) !== null ||
    canResolveActionViaPostLookup(actionType, input) ||
    (actionSupportsPostLookup(actionType) && findNumericPostId(input) === undefined)
  );
}

async function loadActiveSiteConfig(
  siteId: SiteId
): Promise<SiteConfig | null> {
  const db = getDatabase();
  const row = await db.repositories.siteConfigs.getActiveBySiteId(siteId);
  if (!row) {
    return null;
  }

  try {
    return siteConfigSchema.parse(row.document);
  } catch {
    return null;
  }
}

function applySeoMetaProviderToSpec(
  spec: { toolName: string; arguments: Record<string, unknown> },
  siteConfig: SiteConfig | null
): { toolName: string; arguments: Record<string, unknown> } {
  if (spec.toolName !== "sitepilot-set-post-seo-meta" || !siteConfig) {
    return spec;
  }

  return {
    ...spec,
    arguments: {
      ...spec.arguments,
      meta_provider: siteConfig.sections.seoPolicy.metaProvider
    }
  };
}

type UploadedMediaAsset = {
  attachmentId: number;
  url: string;
  fileName: string;
  mediaType: string;
};

type ExternalImageReference = {
  url?: string;
  altText?: string;
};

function normalizeBlockName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("wp:")) {
    const name = trimmed.slice("wp:".length);
    return name.includes("/") ? name : `core/${name}`;
  }
  if (trimmed.startsWith("core:")) {
    return `core/${trimmed.slice("core:".length)}`;
  }
  return trimmed;
}

function dataUrlToBase64(dataUrl: string): string | null {
  const match = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl);
  return match?.[1] ?? null;
}

function mediaTypeToExtension(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/svg+xml") {
    return ".svg";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  return "";
}

function hydrateUploadMediaArgumentsFromAttachment(input: {
  attachment: ImageAttachmentPayload;
  spec: { toolName: string; arguments: Record<string, unknown> };
}):
  | { ok: true; spec: { toolName: string; arguments: Record<string, unknown> } }
  | { ok: false; code: string; message: string } {
  const dataBase64 = dataUrlToBase64(input.attachment.dataUrl);
  if (!dataBase64) {
    return {
      ok: false,
      code: "invalid_attachment_data",
      message: `Image attachment "${input.attachment.fileName}" is not valid base64 image data.`
    };
  }

  return {
    ok: true,
    spec: {
      ...input.spec,
      arguments: {
        ...input.spec.arguments,
        file_name:
          typeof input.spec.arguments.file_name === "string" &&
          input.spec.arguments.file_name.trim().length > 0
            ? input.spec.arguments.file_name
            : input.attachment.fileName,
        media_type:
          typeof input.spec.arguments.media_type === "string" &&
          input.spec.arguments.media_type.trim().length > 0
            ? input.spec.arguments.media_type
            : input.attachment.mediaType,
        data_base64: dataBase64
      }
    }
  };
}

function imageBlockHtml(attrs: Record<string, unknown>): string {
  const url = typeof attrs.url === "string" ? attrs.url : "";
  if (url.length === 0) {
    return "";
  }
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  const sizeSlug = typeof attrs.sizeSlug === "string" ? attrs.sizeSlug : "";
  const id =
    typeof attrs.id === "number"
      ? attrs.id
      : typeof attrs.id === "string"
        ? Number.parseInt(attrs.id, 10)
        : 0;
  const figureClasses = ["wp-block-image"];
  if (sizeSlug.length > 0) {
    figureClasses.push(`size-${sizeSlug}`);
  }
  const imageClass = Number.isFinite(id) && id > 0 ? ` class="wp-image-${id}"` : "";
  return `<figure class="${figureClasses.join(" ")}"><img src="${url}" alt="${alt}"${imageClass}/></figure>`;
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
    classNames.push(`is-vertically-aligned-${attrs.verticalAlignment.trim()}`);
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
  const mediaUrl =
    typeof attrs.mediaUrl === "string" ? attrs.mediaUrl.trim() : "";
  if (mediaUrl.length === 0) {
    return '<figure class="wp-block-media-text__media"></figure>';
  }

  const mediaAlt =
    typeof attrs.mediaAlt === "string"
      ? attrs.mediaAlt
      : typeof attrs.alt === "string"
        ? attrs.alt
        : "";
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
    classes.push(`size-${mediaSizeSlug}`);
  }
  return `<figure class="wp-block-media-text__media"><img src="${escapeHtml(
    mediaUrl
  )}" alt="${escapeHtml(mediaAlt)}"${
    classes.length > 0 ? ` class="${classes.join(" ")}"` : ""
  }/></figure>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isSiteLocalUploadUrl(url: string, siteBaseUrl: string): boolean {
  if (url.trim().length === 0) {
    return true;
  }

  try {
    const imageUrl = new URL(url);
    const baseUrl = new URL(siteBaseUrl);
    return (
      imageUrl.origin === baseUrl.origin &&
      imageUrl.pathname.includes("/wp-content/uploads/")
    );
  } catch {
    return url.includes("/wp-content/uploads/");
  }
}

function urlFileName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? decodeURIComponent(segments.at(-1) ?? "") : null;
  } catch {
    const segments = url.split("/").filter(Boolean);
    return segments.length > 0 ? segments.at(-1) ?? null : null;
  }
}

function fileNameFromUrlOrContentType(url: string, mediaType: string): string {
  const fromUrl = urlFileName(url);
  if (fromUrl && /\.[a-z0-9]+$/i.test(fromUrl)) {
    return fromUrl;
  }

  const fallbackBase = fromUrl && fromUrl.trim().length > 0 ? fromUrl : "external-image";
  const fallbackExt = mediaTypeToExtension(mediaType);
  return /\.[a-z0-9]+$/i.test(fallbackBase)
    ? fallbackBase
    : `${fallbackBase}${fallbackExt}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blockExecutionErrorMessage(blockNames: string[]): string {
  const uniqueNames = [...new Set(blockNames)];
  const reasons = uniqueNames.map((name) => explainUnsupportedBlockName(name));
  return `Execution blocked because the action uses unsupported Gutenberg block types: ${uniqueNames.join(", ")}. ${reasons.join(" ")} Supported blocks today: ${SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES.join(", ")}.`;
}

async function uploadAttachmentsToMediaLibrary(input: {
  attachments: ImageAttachmentPayload[];
  mcpClient: McpHttpClient;
}): Promise<
  | { ok: true; uploads: UploadedMediaAsset[] }
  | { ok: false; code: string; message: string }
> {
  const uploads: UploadedMediaAsset[] = [];

  for (const attachment of input.attachments) {
    const dataBase64 = dataUrlToBase64(attachment.dataUrl);
    if (!dataBase64) {
      return {
        ok: false,
        code: "invalid_attachment_data",
        message: `Image attachment "${attachment.fileName}" is not valid base64 image data.`
      };
    }

    let raw: unknown;
    try {
      raw = await input.mcpClient.callTool("sitepilot-upload-media-asset", {
        file_name: attachment.fileName,
        media_type: attachment.mediaType,
        data_base64: dataBase64,
        dry_run: false
      });
    } catch (error) {
      return {
        ok: false,
        code: "media_upload_failed",
        message:
          error instanceof Error
            ? error.message
            : `Media upload failed for ${attachment.fileName}.`
      };
    }

    const result = normalizeMcpToolResult(raw);
    if (result.ok === false) {
      return {
        ok: false,
        code: "media_upload_failed",
        message:
          typeof result.error === "string" && result.error.trim().length > 0
            ? result.error
            : `Media upload failed for ${attachment.fileName}.`
      };
    }

    const attachmentId = result["attachment_id"];
    const url = result["url"];
    if (
      typeof attachmentId !== "number" ||
      !Number.isFinite(attachmentId) ||
      attachmentId <= 0 ||
      typeof url !== "string" ||
      url.trim().length === 0
    ) {
      return {
        ok: false,
        code: "media_upload_invalid_result",
        message: `Media upload for "${attachment.fileName}" did not return a usable attachment id and URL.`
      };
    }

    uploads.push({
      attachmentId,
      url,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType
    });
  }

  return { ok: true, uploads };
}

function extractExternalImageReferencesFromBlocks(
  blocks: unknown[]
): ExternalImageReference[] {
  const references: ExternalImageReference[] = [];

  const visit = (value: unknown): void => {
    const block = objectRecord(value);
    if (!block) {
      return;
    }

    const blockName = normalizeBlockName(block.blockName);
    const attrs = objectRecord(block.attrs) ?? {};

    if (blockName === "core/image") {
      const url =
        typeof attrs.url === "string"
          ? attrs.url.trim()
          : typeof attrs.src === "string"
            ? attrs.src.trim()
            : "";
      const altText = typeof attrs.alt === "string" ? attrs.alt.trim() : "";
      references.push({
        ...(url.length > 0 ? { url } : {}),
        ...(altText.length > 0 ? { altText } : {})
      });
    }

    if (blockName === "core/media-text") {
      const url =
        typeof attrs.mediaUrl === "string" ? attrs.mediaUrl.trim() : "";
      const altText =
        typeof attrs.mediaAlt === "string"
          ? attrs.mediaAlt.trim()
          : typeof attrs.alt === "string"
            ? attrs.alt.trim()
            : "";
      references.push({
        ...(url.length > 0 ? { url } : {}),
        ...(altText.length > 0 ? { altText } : {})
      });
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

  return references;
}

function extractExternalImageReferencesFromSerializedContent(
  content: string
): ExternalImageReference[] {
  const references: ExternalImageReference[] = [];
  const imageBlockPattern =
    /<!--\s*wp:image(?:\s+({[\s\S]*?}))?\s*-->([\s\S]*?)<!--\s*\/wp:image\s*-->/gi;

  for (const match of content.matchAll(imageBlockPattern)) {
    const attrsJson = match[1];
    const innerHtml = match[2];
    let url = "";

    if (typeof attrsJson === "string" && attrsJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(attrsJson) as unknown;
        const record = objectRecord(parsed);
        if (record) {
          if (typeof record.url === "string") {
            url = record.url.trim();
          } else if (typeof record.src === "string") {
            url = record.src.trim();
          }
        }
      } catch {
        url = "";
      }
    }

    if (url.length === 0 && typeof innerHtml === "string") {
      const imgSrcMatch = /<img\b[^>]*\bsrc=(["'])(.*?)\1/i.exec(innerHtml);
      url = (imgSrcMatch?.[2] ?? "").trim();
    }

    const altMatch =
      typeof innerHtml === "string"
        ? /<img\b[^>]*\balt=(["'])(.*?)\1/i.exec(innerHtml)
        : null;
    const alt =
      typeof attrsJson === "string" && attrsJson.trim().length > 0
        ? (() => {
            try {
              const parsed = JSON.parse(attrsJson) as unknown;
              const record = objectRecord(parsed);
              return typeof record?.alt === "string" ? record.alt.trim() : "";
            } catch {
              return "";
            }
          })()
        : (altMatch?.[2] ?? "").trim();

    references.push({
      ...(url.length > 0 ? { url } : {}),
      ...(alt.length > 0 ? { altText: alt } : {})
    });
  }

  const mediaTextPattern =
    /<!--\s*wp:media-text(?:\s+({[\s\S]*?}))?\s*-->([\s\S]*?)<!--\s*\/wp:media-text\s*-->/gi;

  for (const match of content.matchAll(mediaTextPattern)) {
    const attrsJson = match[1];
    const innerHtml = match[2];
    let url = "";
    let alt = "";

    if (typeof attrsJson === "string" && attrsJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(attrsJson) as unknown;
        const record = objectRecord(parsed);
        if (record) {
          if (typeof record.mediaUrl === "string") {
            url = record.mediaUrl.trim();
          }
          if (typeof record.mediaAlt === "string") {
            alt = record.mediaAlt.trim();
          }
        }
      } catch {
        url = "";
      }
    }

    if (url.length === 0 && typeof innerHtml === "string") {
      const imgSrcMatch = /<img\b[^>]*\bsrc=(["'])(.*?)\1/i.exec(innerHtml);
      url = (imgSrcMatch?.[2] ?? "").trim();
    }
    if (alt.length === 0 && typeof innerHtml === "string") {
      const imgAltMatch = /<img\b[^>]*\balt=(["'])(.*?)\1/i.exec(innerHtml);
      alt = (imgAltMatch?.[2] ?? "").trim();
    }

    references.push({
      ...(url.length > 0 ? { url } : {}),
      ...(alt.length > 0 ? { altText: alt } : {})
    });
  }

  return references;
}

async function downloadExternalImageAsAttachment(url: string): Promise<
  | { ok: true; attachment: ImageAttachmentPayload }
  | { ok: false; code: string; message: string }
> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      ok: false,
      code: "external_image_fetch_failed",
      message:
        error instanceof Error
          ? error.message
          : `Failed to fetch external image ${url}.`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: "external_image_fetch_failed",
      message: `External image fetch failed for ${url} with status ${response.status}.`
    };
  }

  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!mediaType.startsWith("image/")) {
    return {
      ok: false,
      code: "external_image_invalid_type",
      message: `External image ${url} returned unsupported content-type "${mediaType || "unknown"}".`
    };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    return {
      ok: false,
      code: "external_image_fetch_failed",
      message: `External image ${url} returned an empty body.`
    };
  }

  const fileName = fileNameFromUrlOrContentType(url, mediaType);
  return {
    ok: true,
    attachment: {
      fileName,
      mediaType,
      sizeBytes: bytes.length,
      dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`
    }
  };
}

async function collectMediaAttachmentsForSpec(input: {
  requestAttachments: ImageAttachmentPayload[] | undefined;
  spec: { toolName: string; arguments: Record<string, unknown> };
  siteBaseUrl: string;
  requestText: string;
}): Promise<
  | { ok: true; attachments: ImageAttachmentPayload[] }
  | { ok: false; code: string; message: string }
> {
  const attachments = [...(input.requestAttachments ?? [])];
  const candidates: ExternalImageReference[] = [];

  if (Array.isArray(input.spec.arguments.blocks)) {
    candidates.push(
      ...extractExternalImageReferencesFromBlocks(input.spec.arguments.blocks)
    );
  } else if (typeof input.spec.arguments.content === "string") {
    candidates.push(
      ...extractExternalImageReferencesFromSerializedContent(
        input.spec.arguments.content
      )
    );
  }

  for (const candidate of candidates) {
    if (
      typeof candidate.url === "string" &&
      isSiteLocalUploadUrl(candidate.url, input.siteBaseUrl)
    ) {
      continue;
    }
    const resolved = await resolveExternalImageReference({
      currentUrl: candidate.url ?? null,
      altText: candidate.altText ?? null,
      requestText: input.requestText
    });
    if (!resolved) {
      return {
        ok: false,
        code: "external_image_not_found",
        message:
          candidate.altText && candidate.altText.trim().length > 0
            ? `Could not find a usable image for "${candidate.altText}".`
            : "Could not find a usable external image for this action."
      };
    }
    const downloaded = await downloadExternalImageAsAttachment(resolved.url);
    if (!downloaded.ok) {
      return downloaded;
    }
    attachments.push(downloaded.attachment);
  }

  return { ok: true, attachments };
}

export const __testables = {
  extractExternalImageReferencesFromBlocks,
  extractExternalImageReferencesFromSerializedContent,
  collectMediaAttachmentsForSpec,
  downloadExternalImageAsAttachment,
  fileNameFromUrlOrContentType
};

function rewriteBlocksWithUploadedMedia(input: {
  blocks: unknown[];
  uploads: UploadedMediaAsset[];
  siteBaseUrl: string;
}): unknown[] {
  const usedUploadIndexes = new Set<number>();

  const nextUnusedUpload = (): UploadedMediaAsset | undefined => {
    const index = input.uploads.findIndex((_, uploadIndex) => !usedUploadIndexes.has(uploadIndex));
    if (index < 0) {
      return undefined;
    }
    usedUploadIndexes.add(index);
    return input.uploads[index];
  };

  const matchingUploadForUrl = (url: string): UploadedMediaAsset | undefined => {
    const fileName = urlFileName(url);
    if (!fileName) {
      return undefined;
    }
    const index = input.uploads.findIndex(
      (upload, uploadIndex) =>
        !usedUploadIndexes.has(uploadIndex) && upload.fileName === fileName
    );
    if (index < 0) {
      return undefined;
    }
    usedUploadIndexes.add(index);
    return input.uploads[index];
  };

  const visitBlock = (value: unknown): unknown => {
    const block = objectRecord(value);
    if (!block) {
      return value;
    }

    const nextBlock: Record<string, unknown> = { ...block };
    if (Array.isArray(block.innerBlocks)) {
      nextBlock.innerBlocks = block.innerBlocks.map(visitBlock);
    }

    const attrs = objectRecord(block.attrs) ?? {};
    const blockName = normalizeBlockName(block.blockName);

    if (blockName === "core/image") {
      const rawId = attrs.id;
      const imageId =
        typeof rawId === "number"
          ? rawId
          : typeof rawId === "string"
            ? Number.parseInt(rawId, 10)
            : 0;
      const currentUrl =
        typeof attrs.url === "string"
          ? attrs.url
          : typeof attrs.src === "string"
            ? attrs.src
            : "";

      if (Number.isFinite(imageId) && imageId > 0 && currentUrl.length > 0) {
        return nextBlock;
      }

      const upload =
        matchingUploadForUrl(currentUrl) ??
        (isSiteLocalUploadUrl(currentUrl, input.siteBaseUrl)
          ? nextUnusedUpload()
          : undefined);

      if (!upload) {
        return nextBlock;
      }

      const nextAttrs: Record<string, unknown> = {
        ...attrs,
        id: upload.attachmentId,
        url: upload.url
      };
      if (typeof nextAttrs.src === "string") {
        nextAttrs.src = upload.url;
      }

      const innerHtml = imageBlockHtml(nextAttrs);
      nextBlock.attrs = nextAttrs;
      nextBlock.innerHTML = innerHtml;
      nextBlock.innerContent = [innerHtml];

      return nextBlock;
    }

    if (blockName === "core/media-text") {
      const rawMediaId = attrs.mediaId;
      const mediaId =
        typeof rawMediaId === "number"
          ? rawMediaId
          : typeof rawMediaId === "string"
            ? Number.parseInt(rawMediaId, 10)
            : 0;
      const currentUrl =
        typeof attrs.mediaUrl === "string" ? attrs.mediaUrl : "";

      if (Number.isFinite(mediaId) && mediaId > 0 && currentUrl.length > 0) {
        return nextBlock;
      }

      const upload =
        matchingUploadForUrl(currentUrl) ??
        (isSiteLocalUploadUrl(currentUrl, input.siteBaseUrl)
          ? nextUnusedUpload()
          : undefined);
      if (!upload) {
        return nextBlock;
      }

      const nextAttrs: Record<string, unknown> = {
        ...attrs,
        mediaId: upload.attachmentId,
        mediaType: "image",
        mediaUrl: upload.url
      };
      nextBlock.attrs = nextAttrs;
      const contentParts = Array.isArray(nextBlock.innerBlocks)
        ? nextBlock.innerBlocks.map((innerBlock) => {
            const innerRecord = objectRecord(innerBlock);
            return typeof innerRecord?.innerHTML === "string"
              ? innerRecord.innerHTML
              : "";
          })
        : [];
      const contentOpen = '<div class="wp-block-media-text__content">';
      const mediaFigure = mediaTextMediaFigureHtml(nextAttrs);
      nextBlock.innerHTML =
        nextAttrs.mediaPosition === "right"
          ? `${mediaTextWrapperOpen(nextAttrs)}${contentOpen}${contentParts.join(
              ""
            )}</div>${mediaFigure}</div>`
          : `${mediaTextWrapperOpen(nextAttrs)}${mediaFigure}${contentOpen}${contentParts.join(
              ""
            )}</div></div>`;
      nextBlock.innerContent =
        nextAttrs.mediaPosition === "right"
          ? [
              mediaTextWrapperOpen(nextAttrs),
              contentOpen,
              ...contentParts.map(() => null),
              "</div>",
              mediaFigure,
              "</div>"
            ]
          : [
              mediaTextWrapperOpen(nextAttrs),
              mediaFigure,
              contentOpen,
              ...contentParts.map(() => null),
              "</div>",
              "</div>"
            ];
      return nextBlock;
    }

    return nextBlock;
  };

  return input.blocks.map(visitBlock);
}

function rewriteSerializedContentWithUploadedMedia(input: {
  content: string;
  uploads: UploadedMediaAsset[];
  siteBaseUrl: string;
}): string {
  let nextUploadIndex = 0;

  const takeUploadForUrl = (url: string): UploadedMediaAsset | undefined => {
    const fileName = urlFileName(url);
    if (fileName) {
      const matchIndex = input.uploads.findIndex(
        (upload, index) => index >= nextUploadIndex && upload.fileName === fileName
      );
      if (matchIndex >= 0) {
        nextUploadIndex = matchIndex + 1;
        return input.uploads[matchIndex];
      }
    }

    if (isSiteLocalUploadUrl(url, input.siteBaseUrl) && nextUploadIndex < input.uploads.length) {
      const upload = input.uploads[nextUploadIndex];
      nextUploadIndex += 1;
      return upload;
    }

    return undefined;
  };

  const imageBlockPattern =
    /<!--\s*wp:image(?:\s+({[\s\S]*?}))?\s*-->([\s\S]*?)<!--\s*\/wp:image\s*-->/gi;
  let rewritten = input.content.replace(imageBlockPattern, (full, attrsJson, innerHtml) => {
    let attrs: Record<string, unknown> = {};
    if (typeof attrsJson === "string" && attrsJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(attrsJson) as unknown;
        const record = objectRecord(parsed);
        if (record) {
          attrs = record;
        }
      } catch {
        attrs = {};
      }
    }

    const imgSrcMatch = /<img\b[^>]*\bsrc=(["'])(.*?)\1/i.exec(
      typeof innerHtml === "string" ? innerHtml : ""
    );
    const currentUrl =
      typeof attrs.url === "string"
        ? attrs.url
        : typeof attrs.src === "string"
          ? attrs.src
          : imgSrcMatch?.[2] ?? "";
    const rawId = attrs.id;
    const imageId =
      typeof rawId === "number"
        ? rawId
        : typeof rawId === "string"
          ? Number.parseInt(rawId, 10)
          : 0;

    if (Number.isFinite(imageId) && imageId > 0 && currentUrl.length > 0) {
      return full;
    }

    const upload = takeUploadForUrl(currentUrl);
    if (!upload) {
      return full;
    }

    const nextAttrs: Record<string, unknown> = {
      ...attrs,
      id: upload.attachmentId,
      url: upload.url,
      src: upload.url
    };
    const alt =
      typeof nextAttrs.alt === "string" ? nextAttrs.alt : upload.fileName;
    nextAttrs.alt = alt;

    const commentJson = JSON.stringify(nextAttrs);
    const html = `<figure class="wp-block-image"><img src="${escapeHtml(
      upload.url
    )}" alt="${escapeHtml(alt)}" class="wp-image-${upload.attachmentId}"/></figure>`;

    return `<!-- wp:image ${commentJson} -->${html}<!-- /wp:image -->`;
  });

  const mediaTextPattern =
    /<!--\s*wp:media-text(?:\s+({[\s\S]*?}))?\s*-->([\s\S]*?)<!--\s*\/wp:media-text\s*-->/gi;

  rewritten = rewritten.replace(mediaTextPattern, (full, attrsJson, innerHtml) => {
    let attrs: Record<string, unknown> = {};
    if (typeof attrsJson === "string" && attrsJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(attrsJson) as unknown;
        const record = objectRecord(parsed);
        if (record) {
          attrs = record;
        }
      } catch {
        attrs = {};
      }
    }

    const imgSrcMatch = /<img\b[^>]*\bsrc=(["'])(.*?)\1/i.exec(
      typeof innerHtml === "string" ? innerHtml : ""
    );
    const currentUrl =
      typeof attrs.mediaUrl === "string" ? attrs.mediaUrl : imgSrcMatch?.[2] ?? "";
    const rawMediaId = attrs.mediaId;
    const mediaId =
      typeof rawMediaId === "number"
        ? rawMediaId
        : typeof rawMediaId === "string"
          ? Number.parseInt(rawMediaId, 10)
          : 0;

    if (Number.isFinite(mediaId) && mediaId > 0 && currentUrl.length > 0) {
      return full;
    }

    const upload = takeUploadForUrl(currentUrl);
    if (!upload) {
      return full;
    }

    const nextAttrs: Record<string, unknown> = {
      ...attrs,
      mediaId: upload.attachmentId,
      mediaType: "image",
      mediaUrl: upload.url
    };
    const contentMatch =
      /<div class="wp-block-media-text__content">([\s\S]*?)<\/div>\s*<\/div>\s*$/i.exec(
        typeof innerHtml === "string" ? innerHtml : ""
      ) ??
      /<div class="wp-block-media-text__content">([\s\S]*?)<\/div>/i.exec(
        typeof innerHtml === "string" ? innerHtml : ""
      );
    const contentHtml = contentMatch?.[1] ?? "";
    const html =
      nextAttrs.mediaPosition === "right"
        ? `${mediaTextWrapperOpen(nextAttrs)}<div class="wp-block-media-text__content">${contentHtml}</div>${mediaTextMediaFigureHtml(
            nextAttrs
          )}</div>`
        : `${mediaTextWrapperOpen(nextAttrs)}${mediaTextMediaFigureHtml(
            nextAttrs
          )}<div class="wp-block-media-text__content">${contentHtml}</div></div>`;

    return `<!-- wp:media-text ${JSON.stringify(nextAttrs)} -->${html}<!-- /wp:media-text -->`;
  });

  return rewritten;
}

async function hydrateSpecMediaInputs(input: {
  requestAttachments: ImageAttachmentPayload[] | undefined;
  spec: { toolName: string; arguments: Record<string, unknown> };
  mcpClient: McpHttpClient;
  siteBaseUrl: string;
  requestText: string;
}): Promise<
  | { ok: true; spec: { toolName: string; arguments: Record<string, unknown> } }
  | { ok: false; code: string; message: string }
> {
  if (
    input.spec.toolName !== "sitepilot-create-draft-post" &&
    input.spec.toolName !== "sitepilot-update-post-fields" &&
    input.spec.toolName !== "sitepilot-set-post-featured-image" &&
    input.spec.toolName !== "sitepilot-upload-media-asset"
  ) {
    return { ok: true, spec: input.spec };
  }

  if (input.spec.toolName === "sitepilot-upload-media-asset") {
    const hasDataBase64 =
      typeof input.spec.arguments.data_base64 === "string" &&
      input.spec.arguments.data_base64.trim().length > 0;
    if (hasDataBase64) {
      return { ok: true, spec: input.spec };
    }
    if (
      input.requestAttachments === undefined ||
      input.requestAttachments.length === 0
    ) {
      return {
        ok: false,
        code: "missing_attachment",
        message: "Upload media action requires an image attachment."
      };
    }
    return hydrateUploadMediaArgumentsFromAttachment({
      attachment: input.requestAttachments[0]!,
      spec: input.spec
    });
  }

  if (input.spec.toolName === "sitepilot-set-post-featured-image") {
    const existingAttachmentId = input.spec.arguments.attachment_id;
    if (
      typeof existingAttachmentId === "number" &&
      Number.isFinite(existingAttachmentId) &&
      existingAttachmentId > 0
    ) {
      return { ok: true, spec: input.spec };
    }
    const featuredImageUrl =
      typeof input.spec.arguments.featured_image_url === "string"
        ? input.spec.arguments.featured_image_url
        : undefined;
    if (featuredImageUrl) {
      const resolved = await resolveExternalImageReference({
        currentUrl: featuredImageUrl,
        requestText: input.requestText
      });
      if (!resolved) {
        return {
          ok: false,
          code: "external_image_not_found",
          message: "Could not find a usable featured image."
        };
      }

      const downloaded = await downloadExternalImageAsAttachment(resolved.url);
      if (!downloaded.ok) {
        return downloaded;
      }

      const uploadResult = await uploadAttachmentsToMediaLibrary({
        attachments: [downloaded.attachment],
        mcpClient: input.mcpClient
      });
      if (!uploadResult.ok) {
        return uploadResult;
      }

      const attachment = uploadResult.uploads[0];
      if (!attachment) {
        return {
          ok: false,
          code: "media_upload_invalid_result",
          message:
            "Featured image upload did not return a usable attachment id."
        };
      }

      return {
        ok: true,
        spec: {
          ...input.spec,
          arguments: {
            ...input.spec.arguments,
            attachment_id: attachment.attachmentId
          }
        }
      };
    }

    if (
      input.requestAttachments === undefined ||
      input.requestAttachments.length === 0
    ) {
      return {
        ok: false,
        code: "missing_attachment",
        message:
          "Featured image action requires an attachment, featured_image_url, or an existing attachment_id."
      };
    }

    const uploadResult = await uploadAttachmentsToMediaLibrary({
      attachments: [input.requestAttachments[0]!],
      mcpClient: input.mcpClient
    });
    if (!uploadResult.ok) {
      return uploadResult;
    }

    const attachment = uploadResult.uploads[0];
    if (!attachment) {
      return {
        ok: false,
        code: "media_upload_invalid_result",
        message:
          "Featured image upload did not return a usable attachment id."
      };
    }

    return {
      ok: true,
      spec: {
        ...input.spec,
        arguments: {
          ...input.spec.arguments,
          attachment_id: attachment.attachmentId
        }
      }
    };
  }

  const mediaAttachmentsResult = await collectMediaAttachmentsForSpec({
    requestAttachments: input.requestAttachments,
    spec: input.spec,
    siteBaseUrl: input.siteBaseUrl,
    requestText: input.requestText
  });
  if (!mediaAttachmentsResult.ok) {
    return mediaAttachmentsResult;
  }

  if (mediaAttachmentsResult.attachments.length === 0) {
    return { ok: true, spec: input.spec };
  }

  if (!Array.isArray(input.spec.arguments.blocks)) {
    if (typeof input.spec.arguments.content !== "string") {
      return { ok: true, spec: input.spec };
    }

    const uploadResult = await uploadAttachmentsToMediaLibrary({
      attachments: mediaAttachmentsResult.attachments,
      mcpClient: input.mcpClient
    });
    if (!uploadResult.ok) {
      return uploadResult;
    }

    return {
      ok: true,
      spec: {
        ...input.spec,
        arguments: {
          ...input.spec.arguments,
          content: rewriteSerializedContentWithUploadedMedia({
            content: input.spec.arguments.content,
            uploads: uploadResult.uploads,
            siteBaseUrl: input.siteBaseUrl
          })
        }
      }
    };
  }

  const uploadResult = await uploadAttachmentsToMediaLibrary({
    attachments: mediaAttachmentsResult.attachments,
    mcpClient: input.mcpClient
  });
  if (!uploadResult.ok) {
    return uploadResult;
  }

  return {
    ok: true,
    spec: {
      ...input.spec,
      arguments: {
        ...input.spec.arguments,
        blocks: rewriteBlocksWithUploadedMedia({
          blocks: input.spec.arguments.blocks,
          uploads: uploadResult.uploads,
          siteBaseUrl: input.siteBaseUrl
        })
      }
    }
  };
}

async function resolveActionPostId(input: {
  actionType: string;
  actionInput: Record<string, unknown>;
  mcpClient: McpHttpClient;
}): Promise<
  | { ok: true; actionInput: Record<string, unknown> }
  | { ok: false; code: string; message: string }
> {
  if (!canResolveActionViaPostLookup(input.actionType, input.actionInput)) {
    return { ok: true, actionInput: input.actionInput };
  }

  const lookupArgs = buildPostLookupArguments(input.actionInput);
  if (!lookupArgs) {
    return { ok: true, actionInput: input.actionInput };
  }

  let raw: unknown;
  try {
    raw = await input.mcpClient.callTool("sitepilot-find-posts", lookupArgs);
  } catch (error) {
    return {
      ok: false,
      code: "post_lookup_failed",
      message:
        error instanceof Error ? error.message : "Post lookup MCP call failed."
    };
  }

  const lookupResult = normalizeMcpToolResult(raw);
  if (lookupResult.ok === false) {
    return {
      ok: false,
      code: "post_lookup_failed",
      message:
        typeof lookupResult.error === "string"
          ? lookupResult.error
          : "Post lookup MCP call failed."
    };
  }

  const resolved = resolvePostIdFromLookupResult(lookupResult);
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: resolved.message
    };
  }

  return {
    ok: true,
    actionInput: {
      ...input.actionInput,
      post_id: resolved.postId
    }
  };
}

async function appendExecutionMessage(input: {
  siteId: SiteId;
  requestId: RequestId;
  author: { kind: "assistant" } | { kind: "system" };
  text: string;
}): Promise<void> {
  const db = getDatabase();
  const request = await db.repositories.requests.getById(input.requestId);
  if (!request || request.siteId !== input.siteId) {
    return;
  }

  const ts = nowIso();
  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId: request.threadId,
    siteId: input.siteId,
    requestId: input.requestId,
    author: input.author,
    body: { format: "plain_text", value: input.text },
    createdAt: ts,
    updatedAt: ts
  });
}

async function reuseCompletedRun(
  idem: string,
  toolName: string
): Promise<ExecutePlanActionResult> {
  const db = getDatabase();
  const existing =
    await db.repositories.executionRuns.getByIdempotencyKey(idem);
  if (existing === null || existing.status !== "completed") {
    return {
      ok: false,
      code: "execution_reuse_failed",
      message: "Could not load completed execution for idempotency key."
    };
  }
  const invs = await db.repositories.toolInvocations.listByExecutionRunId(
    existing.id
  );
  const first = invs[0];
  return {
    ok: true,
    dryRun: false,
    reused: true,
    toolName,
    mcpResult: (first?.output as Record<string, unknown> | undefined) ?? {},
    executionRunId: existing.id,
    ...(first !== undefined ? { toolInvocationId: first.id } : {})
  };
}

async function loadCompletedPostIdForAction(input: {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  actionId: ActionId;
}): Promise<number | undefined> {
  const db = getDatabase();
  const idem = defaultIdempotencyKey(input);
  const run = await db.repositories.executionRuns.getByIdempotencyKey(idem);
  if (!run || run.status !== "completed") {
    return undefined;
  }

  const invocations = await db.repositories.toolInvocations.listByExecutionRunId(run.id);
  for (const invocation of invocations) {
    if (invocation.status !== "succeeded") {
      continue;
    }
    const postId = extractPostIdFromToolOutput(
      invocation.output as Record<string, unknown> | undefined
    );
    if (postId !== undefined) {
      return postId;
    }
  }

  return undefined;
}

async function hasCompletedActionRun(input: {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  actionId: ActionId;
}): Promise<boolean> {
  const db = getDatabase();
  const idem = defaultIdempotencyKey(input);
  const run = await db.repositories.executionRuns.getByIdempotencyKey(idem);
  return run?.status === "completed";
}

async function resolvePostIdFromEarlierCreateAction(input: {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  plan: { proposedActions: Array<{ id: string; type: string; input: Record<string, unknown> }> };
  actionId: ActionId;
  dryRun: boolean;
}): Promise<
  | { ok: true; postId: number }
  | { ok: false; code: string; message: string }
> {
  const actionIndex = input.plan.proposedActions.findIndex(
    (action) => action.id === input.actionId
  );
  if (actionIndex < 0) {
    return {
      ok: false,
      code: "action_not_found",
      message: "Action not in this plan."
    };
  }

  const priorCreates = input.plan.proposedActions
    .slice(0, actionIndex)
    .filter((action) => actionCreatesDraftPost(action.type));

  if (priorCreates.length === 0) {
    return {
      ok: false,
      code: "post_dependency_missing",
      message: "No earlier create post action exists in this plan to supply a post id."
    };
  }

  if (priorCreates.length > 1) {
    return {
      ok: false,
      code: "post_dependency_ambiguous",
      message:
        "More than one earlier create post action exists in this plan, so the target post id is ambiguous."
    };
  }

  const createAction = priorCreates[0]!;
  const existingPostId = await loadCompletedPostIdForAction({
    siteId: input.siteId,
    requestId: input.requestId,
    planId: input.planId,
    actionId: createAction.id as ActionId
  });
  if (existingPostId !== undefined) {
    return { ok: true, postId: existingPostId };
  }

  if (input.dryRun) {
    return {
      ok: false,
      code: "post_dependency_unavailable_in_dry_run",
      message:
        "Dry-run cannot resolve a post id from the planned create post action until that action has executed."
    };
  }

  const createResult = await executePlanAction({
    siteId: input.siteId,
    requestId: input.requestId,
    planId: input.planId,
    actionId: createAction.id as ActionId,
    dryRun: false
  });
  if (!createResult.ok) {
    return createResult;
  }

  const createdPostId = extractPostIdFromToolOutput(createResult.mcpResult);
  if (createdPostId === undefined) {
    return {
      ok: false,
      code: "post_dependency_missing",
      message:
        "The earlier create post action completed but did not return a usable post id."
    };
  }

  return { ok: true, postId: createdPostId };
}

async function deriveRequestStatusAfterSuccessfulAction(input: {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  plan: { proposedActions: Array<{ id: string; type: string; input: Record<string, unknown> }> };
  completedActionId: ActionId;
}): Promise<"completed" | "partially_completed"> {
  const executableActions = input.plan.proposedActions.filter((action) =>
    actionIsExecutable(action.type, action.input)
  );

  if (executableActions.length <= 1) {
    return "completed";
  }

  const completionChecks = await Promise.all(
    executableActions.map(async (action) => {
      if (action.id === input.completedActionId) {
        return true;
      }
      return hasCompletedActionRun({
        siteId: input.siteId,
        requestId: input.requestId,
        planId: input.planId,
        actionId: action.id as ActionId
      });
    })
  );

  return completionChecks.every(Boolean) ? "completed" : "partially_completed";
}

export async function executePlanAction(
  input: ExecutePlanActionInput
): Promise<ExecutePlanActionResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
  const request = await db.repositories.requests.getById(input.requestId);
  if (!site || !request || request.siteId !== input.siteId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request or site not found for this execution."
    };
  }

  if (
    !input.dryRun &&
    request.status !== "approved" &&
    request.status !== "partially_completed" &&
    request.status !== "completed"
  ) {
    return {
      ok: false,
      code: "not_approved",
      message: "Approve this request before executing actions on the site."
    };
  }

  const plan = await db.repositories.actionPlans.getById(input.planId);
  if (
    !plan ||
    plan.requestId !== input.requestId ||
    plan.siteId !== input.siteId
  ) {
    return {
      ok: false,
      code: "plan_not_found",
      message: "Action plan not found for this request."
    };
  }

  const action = plan.proposedActions.find((a) => a.id === input.actionId);
  if (!action) {
    return {
      ok: false,
      code: "action_not_found",
      message: "Action not in this plan."
    };
  }

  let resolvedInput = action.input;
  if (
    actionSupportsPostLookup(action.type) &&
    findNumericPostId(resolvedInput) === undefined &&
    !canResolveActionViaPostLookup(action.type, resolvedInput)
  ) {
    const priorCreateResolution = await resolvePostIdFromEarlierCreateAction({
      siteId: input.siteId,
      requestId: input.requestId,
      planId: input.planId,
      plan,
      actionId: input.actionId,
      dryRun: input.dryRun
    });
    if (!priorCreateResolution.ok) {
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: `Could not resolve a target post for "${action.type}": ${priorCreateResolution.message}`
      });
      return priorCreateResolution;
    }
    resolvedInput = {
      ...resolvedInput,
      post_id: priorCreateResolution.postId
    };
  }

  const activeSiteConfig = await loadActiveSiteConfig(input.siteId);
  let spec = actionToMcpToolCall(action.type, resolvedInput, input.dryRun);
  if (spec) {
    spec = applySeoMetaProviderToSpec(spec, activeSiteConfig);
  }

  const needsLookup =
    !spec && canResolveActionViaPostLookup(action.type, resolvedInput);
  let mcpClient: McpHttpClient | undefined;

  if (needsLookup) {
    const mcp = await createMcpClientForSite(input.siteId);
    if (!mcp.ok) {
      return mcp;
    }
    mcpClient = mcp.client;
    const resolution = await resolveActionPostId({
      actionType: action.type,
      actionInput: resolvedInput,
      mcpClient
    });
    if (!resolution.ok) {
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: `Could not resolve a unique target post for "${action.type}": ${resolution.message}`
      });
      return resolution;
    }
    resolvedInput = resolution.actionInput;
    spec = actionToMcpToolCall(action.type, resolvedInput, input.dryRun);
    if (spec) {
      spec = applySeoMetaProviderToSpec(spec, activeSiteConfig);
    }
  }

  if (!spec) {
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: `Skipped action "${action.type}" because no MCP tool mapping is defined for it.`
    });
    return {
      ok: true,
      dryRun: input.dryRun,
      skipped: true,
      mcpResult: {
        reason: "no_remote_tool",
        actionType: action.type
      }
    };
  }

  const unsupportedParsedBlocks = Array.isArray(spec.arguments.blocks)
    ? findUnsupportedParsedBlockNames(spec.arguments.blocks)
    : [];
  if (unsupportedParsedBlocks.length > 0) {
    const message = blockExecutionErrorMessage(unsupportedParsedBlocks);
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: message
    });
    return {
      ok: false,
      code: "unsupported_blocks",
      message
    };
  }

  const contentValue = spec.arguments.content;
  if (typeof contentValue === "string") {
    const unsupportedSerializedBlocks =
      findUnsupportedSerializedBlockNames(contentValue);
    if (unsupportedSerializedBlocks.length > 0) {
      const message = blockExecutionErrorMessage(
        unsupportedSerializedBlocks
      );
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: message
      });
      return {
        ok: false,
        code: "unsupported_blocks",
        message
      };
    }
  }

  if (!mcpClient) {
    const mcp = await createMcpClientForSite(input.siteId);
    if (!mcp.ok) {
      return mcp;
    }
    mcpClient = mcp.client;
  }

  if (!input.dryRun) {
    const hydratedSpec = await hydrateSpecMediaInputs({
      requestAttachments: request.attachments,
      spec,
      mcpClient,
      siteBaseUrl: site.baseUrl,
      requestText: request.userPrompt
    });
    if (!hydratedSpec.ok) {
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: `Execution failed before ${spec.toolName}: ${hydratedSpec.message}`
      });
      return hydratedSpec;
    }
    spec = hydratedSpec.spec;
  }

  if (input.dryRun) {
    let raw: unknown;
    try {
      raw = await mcpClient.callTool(spec.toolName, spec.arguments);
    } catch (error) {
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: `Dry-run failed for ${spec.toolName}: ${error instanceof Error ? error.message : "MCP tool call failed."}`
      });
      return {
        ok: false,
        code: "mcp_call_failed",
        message:
          error instanceof Error ? error.message : "MCP tool call failed."
      };
    }
    const mcpResult = normalizeMcpToolResult(raw);
    const toolOk =
      mcpResult.ok === true ||
      (typeof mcpResult.ok === "boolean" && mcpResult.ok);
    if (!toolOk) {
      const siteMessage =
        typeof mcpResult.error === "string" && mcpResult.error.trim().length > 0
          ? mcpResult.error
          : "The site reported that the action did not succeed.";
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: `Dry-run failed for ${spec.toolName}: ${siteMessage}`
      });
      return {
        ok: false,
        code: "tool_reported_failure",
        message: siteMessage
      };
    }
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "assistant" },
      text: `Dry-run completed for ${spec.toolName}.`
    });
    return {
      ok: true,
      dryRun: true,
      toolName: spec.toolName,
      mcpResult
    };
  }

  const explicitIdempotencyKey = input.idempotencyKey !== undefined;
  let idem =
    input.idempotencyKey ??
    defaultIdempotencyKey({
      siteId: input.siteId,
      requestId: input.requestId,
      planId: input.planId,
      actionId: input.actionId
    });

  const prior = await db.repositories.executionRuns.getByIdempotencyKey(idem);
  if (prior !== null) {
    if (prior.status === "completed") {
      return reuseCompletedRun(idem, spec.toolName);
    }
    if (prior.status === "running") {
      return {
        ok: false,
        code: "execution_in_progress",
        message: "This action is already executing."
      };
    }
    if (explicitIdempotencyKey) {
      return {
        ok: false,
        code: "execution_previous_failed",
        message:
          "A previous execution with this idempotency key failed. Pass a new idempotencyKey to retry."
      };
    }
    idem = retryIdempotencyKey(idem);
  }

  const ts = nowIso();
  const runId = randomUUID() as ExecutionRunId;
  const pendingRun: ExecutionRun = {
    id: runId,
    requestId: input.requestId,
    planId: input.planId,
    siteId: input.siteId,
    status: "running",
    idempotencyKey: idem,
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts
  };

  try {
    await db.repositories.executionRuns.save(pendingRun);
  } catch {
    const raced = await db.repositories.executionRuns.getByIdempotencyKey(idem);
    if (raced === null) {
      return {
        ok: false,
        code: "execution_persist_failed",
        message: "Could not record execution run."
      };
    }
    if (raced.status === "completed") {
      return reuseCompletedRun(idem, spec.toolName);
    }
    if (raced.status === "running") {
      return {
        ok: false,
        code: "execution_in_progress",
        message: "This action is already executing."
      };
    }
    return {
      ok: false,
      code: "execution_previous_failed",
      message:
        "A previous execution with this idempotency key failed. Pass a new idempotencyKey to retry."
    };
  }

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: input.requestId,
    actionId: input.actionId,
    eventType: "execution_started",
    actor: DEFAULT_OPERATOR,
    metadata: {
      executionRunId: runId,
      toolName: spec.toolName,
      idempotencyKey: idem
    },
    createdAt: ts,
    updatedAt: ts
  });

  let raw: unknown;
  try {
    raw = await mcpClient.callTool(spec.toolName, spec.arguments);
  } catch (error) {
    const failTs = nowIso();
    const invId = randomUUID() as ToolInvocationId;
    const message =
      error instanceof Error ? error.message : "MCP tool call failed.";
    await db.repositories.toolInvocations.save({
      id: invId,
      executionRunId: runId,
      actionId: input.actionId,
      toolName: spec.toolName,
      status: "failed",
      input: spec.arguments,
      errorCode: "mcp_call_failed",
      createdAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.executionRuns.save({
      ...pendingRun,
      status: "failed",
      completedAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId: input.siteId,
      requestId: input.requestId,
      actionId: input.actionId,
      eventType: "execution_failed",
      actor: DEFAULT_OPERATOR,
      metadata: {
        executionRunId: runId,
        toolName: spec.toolName,
        error: message
      },
      createdAt: failTs,
      updatedAt: failTs
    });
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: `Execution failed for ${spec.toolName}: ${message}`
    });
    return {
      ok: false,
      code: "mcp_call_failed",
      message
    };
  }

  const mcpResult = normalizeMcpToolResult(raw);
  const invId = randomUUID() as ToolInvocationId;
  const toolOk =
    mcpResult.ok === true ||
    (typeof mcpResult.ok === "boolean" && mcpResult.ok);

  if (!toolOk) {
    const failTs = nowIso();
    const siteMessage =
      typeof mcpResult.error === "string" && mcpResult.error.trim().length > 0
        ? mcpResult.error
        : "The site reported that the action did not succeed.";
    await db.repositories.toolInvocations.save({
      id: invId,
      executionRunId: runId,
      actionId: input.actionId,
      toolName: spec.toolName,
      status: "failed",
      input: spec.arguments,
      output: mcpResult,
      errorCode: "tool_reported_failure",
      createdAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.executionRuns.save({
      ...pendingRun,
      status: "failed",
      completedAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId: input.siteId,
      requestId: input.requestId,
      actionId: input.actionId,
      eventType: "execution_failed",
      actor: DEFAULT_OPERATOR,
      metadata: {
        executionRunId: runId,
        toolName: spec.toolName,
        payload: mcpResult
      },
      createdAt: failTs,
      updatedAt: failTs
    });
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: `Execution failed for ${spec.toolName}: ${siteMessage}`
    });
    return {
      ok: false,
      code: "tool_reported_failure",
      message: siteMessage
    };
  }

  const doneTs = nowIso();
  await db.repositories.toolInvocations.save({
    id: invId,
    executionRunId: runId,
    actionId: input.actionId,
    toolName: spec.toolName,
    status: "succeeded",
    input: spec.arguments,
    output: mcpResult,
    createdAt: doneTs,
    updatedAt: doneTs
  });

  await db.repositories.executionRuns.save({
    ...pendingRun,
    status: "completed",
    completedAt: doneTs,
    updatedAt: doneTs
  });

  const nextRequestStatus = await deriveRequestStatusAfterSuccessfulAction({
    siteId: input.siteId,
    requestId: input.requestId,
    planId: input.planId,
    plan,
    completedActionId: input.actionId
  });

  await db.repositories.requests.save({
    ...request,
    latestExecutionRunId: runId,
    status: nextRequestStatus,
    updatedAt: doneTs
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: input.requestId,
    actionId: input.actionId,
    eventType: "tool_invoked",
    actor: DEFAULT_OPERATOR,
    metadata: {
      executionRunId: runId,
      toolName: spec.toolName,
      toolInvocationId: invId
    },
    createdAt: doneTs,
    updatedAt: doneTs
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: input.requestId,
    actionId: input.actionId,
    eventType: "execution_completed",
    actor: DEFAULT_OPERATOR,
    metadata: {
      executionRunId: runId,
      toolName: spec.toolName,
      idempotencyKey: idem
    },
    createdAt: doneTs,
    updatedAt: doneTs
  });

  const beforeSnap = mcpResult["before"];
  if (
    beforeSnap !== null &&
    typeof beforeSnap === "object" &&
    !Array.isArray(beforeSnap)
  ) {
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId: input.siteId,
      requestId: input.requestId,
      actionId: input.actionId,
      eventType: "rollback_recorded",
      actor: DEFAULT_OPERATOR,
      metadata: {
        executionRunId: runId,
        toolName: spec.toolName,
        toolInvocationId: invId,
        snapshot: {
          before: beforeSnap,
          after: mcpResult["after"] ?? null
        }
      },
      createdAt: doneTs,
      updatedAt: doneTs
    });
  }

  await appendExecutionMessage({
    siteId: input.siteId,
    requestId: input.requestId,
    author: { kind: "assistant" },
    text: `${input.dryRun ? "Dry-run completed" : "Execution completed"} for ${spec.toolName}.`
  });

  return {
    ok: true,
    dryRun: false,
    toolName: spec.toolName,
    mcpResult,
    executionRunId: runId,
    toolInvocationId: invId
  };
}
