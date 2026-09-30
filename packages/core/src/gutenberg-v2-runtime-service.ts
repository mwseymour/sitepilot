import { join } from "node:path";

import {
  FileGutenbergV2StagedAssetStore,
  GutenbergV2ContentService,
  type GutenbergV2ExecutionJournal,
  SqlGutenbergV2ApprovalStore,
  SqlGutenbergV2ExecutionJournal,
  type GutenbergV2StagedAssetStore
} from "@sitepilot/services";
import type {
  GutenbergV2ApprovalKeyRequest,
  GutenbergV2ApprovalKeyResponse,
  GutenbergV2BlockFixtureStatus,
  GutenbergV2SourceSnapshot,
  GutenbergV2ThirdPartyReport
} from "@sitepilot/contracts";
import {
  FileGutenbergV2ReviewArtifactStore,
  createSignedGutenbergV2Runtime,
  type SignedGutenbergV2RuntimeOptions
} from "@sitepilot/gutenberg-worker";
import type { SiteId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { fetchSiteUrl, isLoopbackHttpsSiteUrl } from "./site-fetch.js";
import { loadRegisteredSiteContext } from "./site-site-context.js";
import { resolveRuntimeChildPath } from "./runtime-context.js";

export type GutenbergV2DesktopRuntime = {
  content: GutenbergV2ContentService;
  stagedAssets: GutenbergV2StagedAssetStore;
  journal: GutenbergV2ExecutionJournal;
  readReviewArtifact(reference: string): Promise<Buffer>;
  readSource(input: {
    executionId: string;
    siteId: string;
    postType: "post" | "page";
    postId: number;
  }): Promise<GutenbergV2SourceSnapshot>;
  /** Runs and records the per-site save-and-reopen test for ACF blocks. */
  runBlockFixtures?(
    blockNames?: readonly string[]
  ): Promise<GutenbergV2BlockFixtureStatus[]>;
  /** Read-only probe and content scan of the site's third-party blocks. */
  probeThirdPartyBlocks?(): Promise<GutenbergV2ThirdPartyReport>;
  /** Gives the site this desktop's approval key (plugin approval_proof_v1). */
  registerApprovalKey?(
    request: GutenbergV2ApprovalKeyRequest
  ): Promise<GutenbergV2ApprovalKeyResponse>;
  close(): Promise<void>;
};

export type GutenbergV2RuntimeFactory = (input: {
  siteId: SiteId;
  siteUrl: string;
  clientId: string;
  sharedSecret: Buffer;
  stagedAssets: GutenbergV2StagedAssetStore;
  reviewArtifactDirectory: string;
}) => GutenbergV2DesktopRuntime;

let testRuntimeFactory: GutenbergV2RuntimeFactory | undefined;

/** Test/runtime seam for main-service tests; production always uses the signed worker. */
export function configureGutenbergV2RuntimeFactory(
  factory: GutenbergV2RuntimeFactory | undefined
): void {
  testRuntimeFactory = factory;
}

function getArtifactRoot(): string {
  const runtimeRoot = resolveRuntimeChildPath("gutenberg-v2");
  if (runtimeRoot) return runtimeRoot;
  throw new Error(
    "SitePilot's data folder isn't configured. The desktop app and the server set it with configureRuntimeContext at startup."
  );
}

export async function createGutenbergV2DesktopRuntime(
  siteId: SiteId
): Promise<
  | { ok: true; runtime: GutenbergV2DesktopRuntime }
  | { ok: false; code: string; message: string }
> {
  const context = await loadRegisteredSiteContext(siteId);
  if (!context.ok) {
    return { ok: false, code: context.code, message: context.message };
  }

  const root = getArtifactRoot();
  const stagedAssets = new FileGutenbergV2StagedAssetStore(
    join(root, "staged-media", siteId)
  );
  if (testRuntimeFactory) {
    return {
      ok: true,
      runtime: testRuntimeFactory({
        siteId,
        siteUrl: context.site.baseUrl,
        clientId: context.connection.clientIdentifier,
        sharedSecret: context.secret,
        stagedAssets,
        reviewArtifactDirectory: join(root, "review", siteId)
      })
    };
  }

  // Local development sites (*.localhost, loopback IPs) commonly use
  // self-signed certificates; mirror fetchSiteUrl's loopback-only policy.
  const loopbackHttps = isLoopbackHttpsSiteUrl(context.site.baseUrl);
  const options: SignedGutenbergV2RuntimeOptions = {
    siteUrl: context.site.baseUrl,
    siteId,
    clientId: context.connection.clientIdentifier,
    sharedSecret: context.secret,
    stagedAssets,
    reviewArtifactDirectory: join(root, "review", siteId),
    maxConcurrentJobs: 1,
    jobTimeoutMs: 120_000,
    fetchImplementation: fetchSiteUrl,
    ...(loopbackHttps ? { ignoreHTTPSErrors: true } : {})
  };
  const signed = createSignedGutenbergV2Runtime(options);
  const artifacts = new FileGutenbergV2ReviewArtifactStore(
    join(root, "review", siteId)
  );
  const { sql } = getDatabase();
  const journal = new SqlGutenbergV2ExecutionJournal(sql);
  return {
    ok: true,
    runtime: {
      stagedAssets,
      readReviewArtifact: (reference) => artifacts.read(reference),
      readSource: (input) => signed.worker.readSource(input),
      runBlockFixtures: (blockNames) => signed.runBlockFixtures(blockNames),
      probeThirdPartyBlocks: () => signed.probeThirdPartyBlocks(),
      registerApprovalKey: (request) =>
        signed.transport.registerApprovalKey(request),
      close: () => signed.worker.close(),
      journal,
      content: new GutenbergV2ContentService({
        worker: signed.worker,
        wordpress: signed.transport,
        media: signed.media,
        journal,
        approvals: new SqlGutenbergV2ApprovalStore(sql)
      })
    }
  };
}
