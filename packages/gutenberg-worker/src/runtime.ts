import type { Buffer } from "node:buffer";

import type { GutenbergV2BlockFixtureStatus } from "@sitepilot/contracts";

import {
  DurableGutenbergV2MediaService,
  type GutenbergV2StagedAssetStore
} from "@sitepilot/services";

import {
  PlaywrightGutenbergV2Worker,
  type PlaywrightGutenbergV2WorkerOptions
} from "./playwright-worker.js";
import { TrustedGutenbergV2PreviewMediaResolver } from "./preview-media-resolver.js";
import { FileGutenbergV2ReviewArtifactStore } from "./review-artifact-store.js";
import { WordPressEditorSessionClient } from "./session-client.js";
import { SignedWordPressV2Transport } from "./wordpress-transport.js";

export type SignedGutenbergV2RuntimeOptions = Pick<
  PlaywrightGutenbergV2WorkerOptions,
  | "browserFactory"
  | "launchOptions"
  | "allowedAssetOrigins"
  | "ignoreHTTPSErrors"
  | "maxConcurrentJobs"
  | "jobTimeoutMs"
> & {
  siteUrl: string;
  siteId: string;
  clientId: string;
  sharedSecret: Buffer;
  reviewArtifactDirectory: string;
  stagedAssets: GutenbergV2StagedAssetStore;
  fetchImplementation?: typeof fetch;
};

export function createSignedGutenbergV2Runtime(
  options: SignedGutenbergV2RuntimeOptions
) {
  const sessionProvider = new WordPressEditorSessionClient({
    siteUrl: options.siteUrl,
    siteId: options.siteId,
    clientId: options.clientId,
    sharedSecret: options.sharedSecret,
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation })
  });
  let worker: PlaywrightGutenbergV2Worker | undefined;
  const transport = new SignedWordPressV2Transport({
    siteUrl: options.siteUrl,
    siteId: options.siteId,
    clientId: options.clientId,
    sharedSecret: options.sharedSecret,
    sourceReader: {
      readSource: (input) => {
        if (!worker) {
          throw new Error("The Gutenberg v2 worker is not initialized.");
        }
        return worker.readSource(input);
      }
    },
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation })
  });
  const previewMedia = new TrustedGutenbergV2PreviewMediaResolver({
    siteUrl: options.siteUrl,
    stagedAssets: options.stagedAssets,
    mediaBindings: transport,
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation })
  });
  worker = new PlaywrightGutenbergV2Worker({
    siteUrl: options.siteUrl,
    sessionProvider,
    reviewArtifacts: new FileGutenbergV2ReviewArtifactStore(
      options.reviewArtifactDirectory
    ),
    previewMedia,
    ...(options.browserFactory === undefined
      ? {}
      : { browserFactory: options.browserFactory }),
    ...(options.launchOptions === undefined
      ? {}
      : { launchOptions: options.launchOptions }),
    ...(options.allowedAssetOrigins === undefined
      ? {}
      : { allowedAssetOrigins: options.allowedAssetOrigins }),
    ...(options.ignoreHTTPSErrors === undefined
      ? {}
      : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }),
    ...(options.maxConcurrentJobs === undefined
      ? {}
      : { maxConcurrentJobs: options.maxConcurrentJobs }),
    ...(options.jobTimeoutMs === undefined
      ? {}
      : { jobTimeoutMs: options.jobTimeoutMs })
  });
  const media = new DurableGutenbergV2MediaService({
    stagedAssets: options.stagedAssets,
    transport
  });
  /**
   * Tests ACF blocks on the site: runs each block's native save-and-reopen
   * fixture in a scratch editor, then has the plugin re-check and record it.
   * A block becomes authorable only when its recorded status is `passed`.
   */
  const runBlockFixtures = async (
    blockNames?: readonly string[]
  ): Promise<GutenbergV2BlockFixtureStatus[]> => {
    const capabilities = await worker.discoverCapabilities({
      siteId: options.siteId,
      postType: "page"
    });
    const names = capabilities.blocks
      .filter(
        (block) =>
          block.acf?.authorable === true &&
          (blockNames === undefined || blockNames.includes(block.name))
      )
      .map((block) => block.name);
    const statuses: GutenbergV2BlockFixtureStatus[] = capabilities.blocks
      .filter(
        (block) =>
          block.acf !== undefined &&
          !block.acf.authorable &&
          (blockNames === undefined || blockNames.includes(block.name))
      )
      .map((block) => ({
        blockName: block.name,
        status: "unsupported" as const,
        message: `Needs fields v2 cannot fill: ${(block.acf?.unsupportedFields ?? []).join(", ")}.`
      }));
    // One editor job per block keeps each within the worker's job deadline.
    for (const name of names) {
      const { results } = await worker.runBlockFixtures({
        siteId: options.siteId,
        blockNames: [name]
      });
      for (const result of results) {
        statuses.push(await transport.recordBlockFixture(result));
      }
    }
    return statuses;
  };
  return { worker, transport, media, runBlockFixtures };
}
