import {
  GUTENBERG_V2_LIMITS,
  gutenbergV2MediaBindingsResponseSchema,
  type GutenbergV2BlockPlan,
  type GutenbergV2MediaIntent,
  type GutenbergV2MediaMapping,
  type GutenbergV2PreviewMediaMapping
} from "@sitepilot/contracts";
import {
  gutenbergV2MediaBindingId,
  hashGutenbergV2Bytes,
  hashGutenbergV2Content,
  type GutenbergV2MediaBindingTransport,
  type GutenbergV2PreviewMediaResolver,
  type GutenbergV2StagedAssetStore
} from "@sitepilot/services";

import { GutenbergV2WorkerError } from "./worker-error.js";

const MEDIA_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
} as const;

type PreviewMediaType = keyof typeof MEDIA_EXTENSIONS;

export type TrustedGutenbergV2PreviewMediaResolverOptions = {
  siteUrl: string;
  stagedAssets: GutenbergV2StagedAssetStore;
  mediaBindings: GutenbergV2MediaBindingTransport;
  fetchImplementation?: typeof fetch;
};

function mediaTypeForBytes(bytes: Uint8Array): PreviewMediaType | null {
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
  return null;
}

async function boundedResponseBytes(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > GUTENBERG_V2_LIMITS.maxMediaAssetBytes
  ) {
    throw new GutenbergV2WorkerError(
      "request_too_large",
      "A library preview asset exceeded 10 MB.",
      false
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > GUTENBERG_V2_LIMITS.maxMediaAssetBytes) {
      await reader.cancel();
      throw new GutenbergV2WorkerError(
        "request_too_large",
        "A library preview asset exceeded 10 MB.",
        false
      );
    }
    chunks.push(item.value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
}

export class TrustedGutenbergV2PreviewMediaResolver implements GutenbergV2PreviewMediaResolver {
  readonly #siteUrl: URL;
  readonly #stagedAssets: GutenbergV2StagedAssetStore;
  readonly #mediaBindings: GutenbergV2MediaBindingTransport;
  readonly #fetch: typeof fetch;

  public constructor(options: TrustedGutenbergV2PreviewMediaResolverOptions) {
    this.#siteUrl = new URL(options.siteUrl);
    this.#stagedAssets = options.stagedAssets;
    this.#mediaBindings = options.mediaBindings;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  public async resolvePreviewMedia(
    plan: GutenbergV2BlockPlan,
    existingBindings?: GutenbergV2MediaMapping[]
  ): Promise<GutenbergV2PreviewMediaMapping[]> {
    const resolvedLibrary =
      existingBindings ?? (await this.resolveExistingMediaBindings(plan));
    const libraryMappings = new Map(
      resolvedLibrary.map((mapping) => [
        mapping.ref,
        {
          attachmentId: mapping.attachmentId,
          checksum: mapping.finalChecksum,
          url: mapping.url
        }
      ])
    );
    const result: GutenbergV2PreviewMediaMapping[] = [];
    let aggregateBytes = 0;
    for (const media of plan.media) {
      let bytes: Buffer;
      let mediaType: PreviewMediaType;
      if (media.source.kind === "staged_asset") {
        const extension =
          MEDIA_EXTENSIONS[media.source.mediaType as PreviewMediaType];
        if (!extension) {
          throw new GutenbergV2WorkerError(
            "unsupported_v2_block",
            `Preview media ${media.ref} is not a supported raster image.`,
            false
          );
        }
        mediaType = media.source.mediaType as PreviewMediaType;
        bytes = await this.#stagedAssets.read({
          stagedAssetId: media.source.stagedAssetId,
          checksum: media.source.checksum,
          mediaType,
          byteLength: media.source.byteLength,
          fileName: `${media.source.checksum}.${extension}`
        });
      } else {
        const mapping = libraryMappings.get(media.ref);
        if (!mapping) {
          throw new GutenbergV2WorkerError(
            "media_changed",
            `Library preview ${media.ref} has no trusted mapping.`,
            false
          );
        }
        const url = new URL(mapping.url);
        if (url.origin !== this.#siteUrl.origin) {
          throw new GutenbergV2WorkerError(
            "permission_denied",
            `Library preview ${media.ref} is outside the configured WordPress origin.`,
            false
          );
        }
        const response = await this.#fetch(url, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "image/jpeg,image/png,image/webp,image/gif" }
        });
        if (response.status >= 300 && response.status < 400) {
          throw new GutenbergV2WorkerError(
            "permission_denied",
            "Library preview redirects are not allowed.",
            false
          );
        }
        if (!response.ok) {
          throw new GutenbergV2WorkerError(
            "editor_unavailable",
            `Library preview ${media.ref} returned HTTP ${response.status}.`,
            true
          );
        }
        bytes = await boundedResponseBytes(response);
        const detected = mediaTypeForBytes(bytes);
        if (!detected || hashGutenbergV2Bytes(bytes) !== mapping.checksum) {
          throw new GutenbergV2WorkerError(
            "media_changed",
            `Library preview ${media.ref} bytes do not match approval.`,
            false
          );
        }
        mediaType = detected;
      }
      aggregateBytes += bytes.byteLength;
      if (aggregateBytes > GUTENBERG_V2_LIMITS.maxMediaBindingRequestBytes) {
        throw new GutenbergV2WorkerError(
          "request_too_large",
          "Private preview media exceeds the 25 MB aggregate limit.",
          false
        );
      }
      result.push({
        ref: media.ref,
        approvedChecksum: media.source.checksum,
        dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`
      });
    }
    return result;
  }

  public async resolveExistingMediaBindings(
    plan: GutenbergV2BlockPlan
  ): Promise<GutenbergV2MediaMapping[]> {
    const library = plan.media.filter(
      (
        media
      ): media is GutenbergV2MediaIntent & {
        source: {
          kind: "library_attachment";
          attachmentId: number;
          checksum: string;
        };
      } => media.source.kind === "library_attachment"
    );
    if (library.length === 0) return [];
    const executionId = `preview-${hashGutenbergV2Content(plan.planId)}`;
    const response = gutenbergV2MediaBindingsResponseSchema.parse(
      await this.#mediaBindings.resolveMediaBindings({
        schemaVersion: "sitepilot.media-bindings-request/v2",
        executionId,
        idempotencyKey: executionId,
        siteId: plan.siteId,
        items: library.map((media) => ({
          ref: media.ref,
          bindingId: gutenbergV2MediaBindingId(executionId, media.ref),
          approvedChecksum: media.source.checksum,
          kind: media.source.kind,
          attachmentId: media.source.attachmentId
        }))
      })
    );
    if (
      response.createdMediaIds.length !== 0 ||
      response.mapping.length !== library.length
    ) {
      throw new GutenbergV2WorkerError(
        "media_changed",
        "A library preview must not create or substitute media.",
        false
      );
    }
    const expected = new Map(library.map((media) => [media.ref, media]));
    for (const mapping of response.mapping) {
      const media = expected.get(mapping.ref);
      if (
        !media ||
        media.source.kind !== "library_attachment" ||
        mapping.attachmentId !== media.source.attachmentId ||
        mapping.approvedChecksum !== media.source.checksum ||
        mapping.finalChecksum !== media.source.checksum
      ) {
        throw new GutenbergV2WorkerError(
          "media_changed",
          `Library preview ${mapping.ref} changed approved identity.`,
          false
        );
      }
      expected.delete(mapping.ref);
    }
    if (expected.size !== 0) {
      throw new GutenbergV2WorkerError(
        "media_changed",
        "The library preview response omitted approved media.",
        false
      );
    }
    return response.mapping;
  }
}
