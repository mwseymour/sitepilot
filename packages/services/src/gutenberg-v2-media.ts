import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  GUTENBERG_V2_LIMITS,
  gutenbergV2MediaBindingsRequestSchema,
  gutenbergV2MediaBindingsResponseSchema,
  type GutenbergV2Approval,
  type GutenbergV2BlockPlan,
  type GutenbergV2CompiledCandidate,
  type GutenbergV2MediaBindingItem,
  type GutenbergV2MediaBindingsRequest,
  type GutenbergV2MediaBindingsResponse,
  type GutenbergV2MediaIntent,
  type GutenbergV2MediaMapping,
  type GutenbergV2PreviewMediaMapping
} from "@sitepilot/contracts";

import type { GutenbergV2MediaService } from "./gutenberg-v2-content-service.js";
import { GutenbergV2ServiceError } from "./gutenberg-v2-content-service.js";
import {
  hashGutenbergV2Bytes,
  hashGutenbergV2Content,
  hashGutenbergV2Value
} from "./gutenberg-v2-hashing.js";

const MEDIA_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm"
} as const;

type StagedMediaType = keyof typeof MEDIA_TYPES;

export type GutenbergV2StagedAsset = {
  stagedAssetId: string;
  checksum: string;
  mediaType: StagedMediaType;
  byteLength: number;
  fileName: string;
};

export interface GutenbergV2StagedAssetStore {
  stage(input: {
    bytes: Uint8Array;
    mediaType: StagedMediaType;
  }): Promise<GutenbergV2StagedAsset>;
  read(input: GutenbergV2StagedAsset): Promise<Buffer>;
}

export function detectGutenbergV2MediaType(
  bytes: Uint8Array
): StagedMediaType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  // ISO base media (MP4): a box size, then "ftyp" and an MP4-family brand.
  if (
    header.slice(4, 8) === "ftyp" &&
    /^(?:isom|iso[2-6]|mp41|mp42|avc1|dash|M4V )$/.test(header.slice(8, 12))
  ) {
    return "video/mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  return null;
}

export class FileGutenbergV2StagedAssetStore implements GutenbergV2StagedAssetStore {
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new TypeError("A private staged media directory is required.");
    }
    this.#rootDirectory = resolve(rootDirectory);
  }

  public async stage(input: {
    bytes: Uint8Array;
    mediaType: StagedMediaType;
  }): Promise<GutenbergV2StagedAsset> {
    const bytes = Buffer.from(input.bytes);
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > GUTENBERG_V2_LIMITS.maxMediaAssetBytes
    ) {
      throw new GutenbergV2ServiceError(
        "request_too_large",
        "A staged media asset must contain 1 byte to 10 MB."
      );
    }
    if (detectGutenbergV2MediaType(bytes) !== input.mediaType) {
      throw new GutenbergV2ServiceError(
        "schema_invalid",
        "The staged media bytes do not match the declared image or video type."
      );
    }
    const checksum = hashGutenbergV2Bytes(bytes);
    const fileName = `${checksum}.${MEDIA_TYPES[input.mediaType]}`;
    const stagedAssetId = fileName;
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#rootDirectory, 0o700);
    const path = join(this.#rootDirectory, fileName);
    const temporaryPath = join(
      this.#rootDirectory,
      `.${fileName}.${randomUUID()}.tmp`
    );
    try {
      const handle = await open(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.#readPath(path);
        if (!existing.equals(bytes)) {
          throw new GutenbergV2ServiceError(
            "media_changed",
            "A staged media checksum collided with different bytes."
          );
        }
      }
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return {
      stagedAssetId,
      checksum,
      mediaType: input.mediaType,
      byteLength: bytes.byteLength,
      fileName
    };
  }

  public async read(input: GutenbergV2StagedAsset): Promise<Buffer> {
    const extension = MEDIA_TYPES[input.mediaType];
    const expectedName = `${input.checksum}.${extension}`;
    if (
      input.stagedAssetId !== expectedName ||
      input.fileName !== expectedName ||
      basename(input.stagedAssetId) !== input.stagedAssetId
    ) {
      throw new GutenbergV2ServiceError(
        "media_changed",
        "The staged media identity does not match its immutable checksum."
      );
    }
    const bytes = await this.#readPath(
      join(this.#rootDirectory, input.stagedAssetId)
    );
    if (
      bytes.byteLength !== input.byteLength ||
      hashGutenbergV2Bytes(bytes) !== input.checksum ||
      detectGutenbergV2MediaType(bytes) !== input.mediaType
    ) {
      throw new GutenbergV2ServiceError(
        "media_changed",
        "The staged media bytes changed after review."
      );
    }
    return bytes;
  }

  async #readPath(path: string): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > GUTENBERG_V2_LIMITS.maxMediaAssetBytes
      ) {
        throw new GutenbergV2ServiceError(
          "request_too_large",
          "The staged media file is not a bounded regular file."
        );
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}

export interface GutenbergV2MediaBindingTransport {
  resolveMediaBindings(
    request: GutenbergV2MediaBindingsRequest
  ): Promise<GutenbergV2MediaBindingsResponse>;
}

export interface GutenbergV2PreviewMediaResolver {
  resolvePreviewMedia(
    plan: GutenbergV2BlockPlan,
    existingBindings?: GutenbergV2MediaMapping[]
  ): Promise<GutenbergV2PreviewMediaMapping[]>;
  resolveExistingMediaBindings?(
    plan: GutenbergV2BlockPlan
  ): Promise<GutenbergV2MediaMapping[]>;
}

export function hashGutenbergV2PreviewMediaManifest(
  mapping: GutenbergV2PreviewMediaMapping[]
): string {
  return hashGutenbergV2Value(
    mapping
      .map(({ ref, approvedChecksum }) => ({ ref, approvedChecksum }))
      .sort((left, right) =>
        left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0
      )
  );
}

export class StagedGutenbergV2PreviewMediaResolver implements GutenbergV2PreviewMediaResolver {
  readonly #stagedAssets: GutenbergV2StagedAssetStore;

  public constructor(stagedAssets: GutenbergV2StagedAssetStore) {
    this.#stagedAssets = stagedAssets;
  }

  public async resolvePreviewMedia(
    plan: GutenbergV2BlockPlan
  ): Promise<GutenbergV2PreviewMediaMapping[]> {
    const mapping: GutenbergV2PreviewMediaMapping[] = [];
    for (const media of plan.media) {
      if (media.source.kind !== "staged_asset") {
        throw new GutenbergV2ServiceError(
          "media_changed",
          `Library media ${media.ref} needs a trusted destination preview resolver.`
        );
      }
      const extension = MEDIA_TYPES[media.source.mediaType as StagedMediaType];
      if (!extension) {
        throw new GutenbergV2ServiceError(
          "unsupported_v2_block",
          `Staged media ${media.ref} is not a supported image or video type.`
        );
      }
      const bytes = await this.#stagedAssets.read({
        stagedAssetId: media.source.stagedAssetId,
        checksum: media.source.checksum,
        mediaType: media.source.mediaType as StagedMediaType,
        byteLength: media.source.byteLength,
        fileName: `${media.source.checksum}.${extension}`
      });
      mapping.push({
        ref: media.ref,
        approvedChecksum: media.source.checksum,
        dataUrl: `data:${media.source.mediaType};base64,${bytes.toString("base64")}`
      });
    }
    return mapping;
  }
}

export type DurableGutenbergV2MediaServiceOptions = {
  stagedAssets: GutenbergV2StagedAssetStore;
  transport: GutenbergV2MediaBindingTransport;
};

export function gutenbergV2MediaBindingId(
  executionId: string,
  ref: string
): string {
  return hashGutenbergV2Content(`${executionId}\0${ref}`);
}

function sourceForRef(
  candidate: GutenbergV2CompiledCandidate,
  ref: string
): GutenbergV2MediaIntent {
  const matches = candidate.intent.media.filter((entry) => entry.ref === ref);
  if (matches.length !== 1) {
    throw new GutenbergV2ServiceError(
      "media_changed",
      `Approved media ${ref} is not uniquely represented in the plan.`
    );
  }
  return matches[0]!;
}

export class DurableGutenbergV2MediaService implements GutenbergV2MediaService {
  readonly #stagedAssets: GutenbergV2StagedAssetStore;
  readonly #transport: GutenbergV2MediaBindingTransport;

  public constructor(options: DurableGutenbergV2MediaServiceOptions) {
    this.#stagedAssets = options.stagedAssets;
    this.#transport = options.transport;
  }

  public async resolveForCommit(input: {
    executionId: string;
    idempotencyKey: string;
    candidate: GutenbergV2CompiledCandidate;
    approval: GutenbergV2Approval;
  }): Promise<GutenbergV2MediaBindingsResponse> {
    if (
      input.approval.binding.mediaManifestHash !==
        input.candidate.mediaManifestHash ||
      hashGutenbergV2Value(input.candidate.mediaManifest) !==
        input.candidate.mediaManifestHash
    ) {
      throw new GutenbergV2ServiceError(
        "approval_invalid",
        "The approved media manifest changed before binding."
      );
    }
    const items: GutenbergV2MediaBindingItem[] = [];
    for (const manifest of input.candidate.mediaManifest) {
      const media = sourceForRef(input.candidate, manifest.ref);
      const bindingId = gutenbergV2MediaBindingId(
        input.executionId,
        manifest.ref
      );
      if (
        media.source.checksum !== manifest.approvedChecksum ||
        media.alt !== manifest.alt ||
        media.caption !== manifest.caption
      ) {
        throw new GutenbergV2ServiceError(
          "media_changed",
          `Approved media ${manifest.ref} no longer matches its intent.`
        );
      }
      if (media.source.kind === "library_attachment") {
        items.push({
          ref: media.ref,
          bindingId,
          approvedChecksum: media.source.checksum,
          kind: media.source.kind,
          attachmentId: media.source.attachmentId
        });
        continue;
      }
      const extension = MEDIA_TYPES[media.source.mediaType as StagedMediaType];
      if (!extension) {
        throw new GutenbergV2ServiceError(
          "unsupported_v2_block",
          `Staged media ${media.ref} is not a supported image or video type.`
        );
      }
      const asset: GutenbergV2StagedAsset = {
        stagedAssetId: media.source.stagedAssetId,
        checksum: media.source.checksum,
        mediaType: media.source.mediaType as StagedMediaType,
        byteLength: media.source.byteLength,
        fileName: `${media.source.checksum}.${extension}`
      };
      const bytes = await this.#stagedAssets.read(asset);
      items.push({
        ref: media.ref,
        bindingId,
        approvedChecksum: media.source.checksum,
        kind: media.source.kind,
        stagedAssetId: media.source.stagedAssetId,
        mediaType: asset.mediaType,
        byteLength: bytes.byteLength,
        fileName: asset.fileName,
        dataBase64: bytes.toString("base64"),
        alt: media.alt,
        ...(media.caption === undefined ? {} : { caption: media.caption })
      });
    }
    const request = gutenbergV2MediaBindingsRequestSchema.parse({
      schemaVersion: "sitepilot.media-bindings-request/v2",
      executionId: input.executionId,
      idempotencyKey: input.idempotencyKey,
      siteId: input.candidate.siteId,
      items
    });
    const response = gutenbergV2MediaBindingsResponseSchema.parse(
      await this.#transport.resolveMediaBindings(request)
    );
    if (
      response.mapping.length !== items.length ||
      response.createdMediaIds.some(
        (id, index, all) => all.indexOf(id) !== index
      )
    ) {
      throw new GutenbergV2ServiceError(
        "media_changed",
        "The media binding response does not cover the approved request exactly."
      );
    }
    const expected = new Map(items.map((item) => [item.ref, item]));
    const stagedAttachmentIds = new Set<number>();
    for (const mapping of response.mapping) {
      const item = expected.get(mapping.ref);
      if (
        !item ||
        mapping.approvedChecksum !== item.approvedChecksum ||
        mapping.finalChecksum !== item.approvedChecksum
      ) {
        throw new GutenbergV2ServiceError(
          "media_changed",
          `The media binding response changed ${mapping.ref}.`
        );
      }
      if (
        item.kind === "library_attachment" &&
        mapping.attachmentId !== item.attachmentId
      ) {
        throw new GutenbergV2ServiceError(
          "media_changed",
          `Library media ${mapping.ref} resolved to a different attachment.`
        );
      }
      if (item.kind === "staged_asset") {
        stagedAttachmentIds.add(mapping.attachmentId);
      }
      expected.delete(mapping.ref);
    }
    if (expected.size !== 0) {
      throw new GutenbergV2ServiceError(
        "media_changed",
        "The media binding response omitted an approved item."
      );
    }
    if (
      response.createdMediaIds.length !== stagedAttachmentIds.size ||
      response.createdMediaIds.some((id) => !stagedAttachmentIds.has(id))
    ) {
      throw new GutenbergV2ServiceError(
        "media_changed",
        "Created media evidence must cover staged assets and exclude existing library attachments."
      );
    }
    return response;
  }
}
