import type { Buffer } from "node:buffer";

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
  return { worker, transport, media };
}
