import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  gutenbergV2ApprovalKeyRequestSchema,
  gutenbergV2ApprovalKeyResponseSchema,
  type GutenbergV2ApprovalKeyRequest,
  type GutenbergV2ApprovalKeyResponse,
  gutenbergV2CommitReceiptSchema,
  gutenbergV2CommitRequestSchema,
  gutenbergV2MediaBindingsRequestSchema,
  gutenbergV2MediaBindingsResponseSchema,
  gutenbergV2PrepareCommitRequestSchema,
  gutenbergV2PrepareCommitResponseSchema,
  gutenbergV2ReadbackRequestSchema,
  gutenbergV2ReadbackSchema,
  gutenbergV2ReconcileRequestSchema,
  gutenbergV2ReconcileResponseSchema,
  gutenbergV2RecoverRequestSchema,
  gutenbergV2RecoverResponseSchema,
  gutenbergV2RenderCheckSchema,
  type GutenbergV2CommitReceipt,
  type GutenbergV2MediaBindingsRequest,
  type GutenbergV2MediaBindingsResponse,
  type GutenbergV2PrepareCommitRequest,
  type GutenbergV2PrepareCommitResponse,
  type GutenbergV2Readback,
  type GutenbergV2RecoverResponse,
  type GutenbergV2RenderCheck,
  type GutenbergV2SourceSnapshot,
  gutenbergV2BlockFixtureStatusSchema,
  gutenbergV2BlockUsageSchema,
  type GutenbergV2BlockFixtureResult,
  type GutenbergV2BlockFixtureStatus,
  type GutenbergV2BlockUsage
} from "@sitepilot/contracts";
import { signSitePilotHmacRequest } from "@sitepilot/plugin-protocol";
import type {
  GutenbergV2MediaBindingTransport,
  GutenbergV2WordPressTransport
} from "@sitepilot/services";

import {
  GutenbergV2WorkerError,
  workerErrorFromWordPress
} from "./worker-error.js";

export interface GutenbergV2SourceReader {
  readSource(input: {
    executionId: string;
    siteId: string;
    postType: "post" | "page";
    postId: number;
    expectedFingerprint?: string;
  }): Promise<GutenbergV2SourceSnapshot>;
}

export type SignedWordPressV2TransportOptions = {
  siteUrl: string;
  siteId: string;
  clientId: string;
  sharedSecret: Buffer;
  sourceReader: GutenbergV2SourceReader;
  fetchImplementation?: typeof fetch;
  /** Longest a v2 request may take, in milliseconds. Defaults to 180 seconds, for media uploads. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 180_000;

const endpointNames = {
  prepare: "prepare",
  commit: "commit",
  reconcile: "reconcile",
  readback: "readback",
  recover: "recover",
  mediaBindings: "media-bindings",
  blockFixtures: "block-fixtures",
  blockUsage: "block-usage",
  renderCheck: "render-check",
  approvalKey: "approval-key"
} as const;

export class SignedWordPressV2Transport
  implements GutenbergV2WordPressTransport, GutenbergV2MediaBindingTransport
{
  readonly #siteUrl: URL;
  readonly #siteId: string;
  readonly #clientId: string;
  readonly #sharedSecret: Buffer;
  readonly #sourceReader: GutenbergV2SourceReader;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(options: SignedWordPressV2TransportOptions) {
    this.#siteUrl = new URL(
      options.siteUrl.endsWith("/") ? options.siteUrl : `${options.siteUrl}/`
    );
    this.#siteId = options.siteId;
    this.#clientId = options.clientId;
    this.#sharedSecret = Buffer.from(options.sharedSecret);
    this.#sourceReader = options.sourceReader;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Registers or replaces this client's approval key on the site (plugin
   * feature approval_proof_v1). From then on the site refuses v2 writes
   * without a signed approval.
   */
  public async registerApprovalKey(
    request: GutenbergV2ApprovalKeyRequest
  ): Promise<GutenbergV2ApprovalKeyResponse> {
    const response = gutenbergV2ApprovalKeyResponseSchema.parse(
      await this.#post(
        endpointNames.approvalKey,
        gutenbergV2ApprovalKeyRequestSchema.parse(request)
      )
    );
    if (response.keyId !== request.keyId) {
      throw new GutenbergV2WorkerError(
        "schema_invalid",
        "The site registered a different approval key.",
        false
      );
    }
    return response;
  }

  /**
   * Renders the saved post in WordPress (plugin feature render_check_v1).
   * Returns null when the plugin has no render check. A crash while
   * rendering (a 5xx, often WordPress's critical-error page) is a failed
   * render, not a reason to retry.
   */
  public async renderCheck(input: {
    siteId: string;
    postId: number;
  }): Promise<GutenbergV2RenderCheck | null> {
    if (input.siteId !== this.#siteId) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "The render check site does not match transport configuration.",
        false
      );
    }
    try {
      return gutenbergV2RenderCheckSchema.parse(
        await this.#post(endpointNames.renderCheck, {
          schemaVersion: "sitepilot.render-check-request/v2",
          postId: input.postId
        })
      );
    } catch (error) {
      if (error instanceof GutenbergV2WorkerError && error.httpStatus === 404) {
        return null;
      }
      if (
        error instanceof GutenbergV2WorkerError &&
        error.httpStatus !== undefined &&
        error.httpStatus >= 500
      ) {
        return {
          schemaVersion: "sitepilot.render-check/v2",
          postId: input.postId,
          outcome: "render_error",
          message: `WordPress failed while rendering the post (HTTP ${error.httpStatus}).`
        };
      }
      throw error;
    }
  }

  public async readSource(
    input: Parameters<GutenbergV2WordPressTransport["readSource"]>[0]
  ): Promise<GutenbergV2SourceSnapshot> {
    if (input.siteId !== this.#siteId) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "The source request site does not match transport configuration.",
        false
      );
    }
    return this.#sourceReader.readSource({
      executionId: `source-${randomUUID()}`,
      siteId: input.siteId,
      postType: input.target.postType,
      postId: input.target.postId
    });
  }

  public async prepareCommit(
    input: GutenbergV2PrepareCommitRequest
  ): Promise<GutenbergV2PrepareCommitResponse> {
    const request = gutenbergV2PrepareCommitRequestSchema.parse(input);
    this.#assertSite(request.candidate.siteId);
    return gutenbergV2PrepareCommitResponseSchema.parse(
      await this.#post(endpointNames.prepare, request)
    );
  }

  public async commitCandidate(
    input: Parameters<GutenbergV2WordPressTransport["commitCandidate"]>[0]
  ): Promise<GutenbergV2CommitReceipt> {
    const request = gutenbergV2CommitRequestSchema.parse(input);
    return gutenbergV2CommitReceiptSchema.parse(
      await this.#post(endpointNames.commit, request)
    );
  }

  public async reconcileExecution(
    input: Parameters<GutenbergV2WordPressTransport["reconcileExecution"]>[0]
  ): Promise<GutenbergV2CommitReceipt | null> {
    const request = gutenbergV2ReconcileRequestSchema.parse(input);
    this.#assertSite(request.siteId);
    return gutenbergV2ReconcileResponseSchema.parse(
      await this.#post(endpointNames.reconcile, request)
    ).receipt;
  }

  public async readBack(
    input: Parameters<GutenbergV2WordPressTransport["readBack"]>[0]
  ): Promise<GutenbergV2Readback> {
    const request = gutenbergV2ReadbackRequestSchema.parse(input);
    this.#assertSite(request.siteId);
    return gutenbergV2ReadbackSchema.parse(
      await this.#post(endpointNames.readback, request)
    );
  }

  public async conditionalRollback(
    input: Parameters<GutenbergV2WordPressTransport["conditionalRollback"]>[0]
  ): Promise<GutenbergV2RecoverResponse> {
    const request = gutenbergV2RecoverRequestSchema.parse(input);
    this.#assertSite(request.siteId);
    return gutenbergV2RecoverResponseSchema.parse(
      await this.#post(endpointNames.recover, request)
    );
  }

  public async resolveMediaBindings(
    input: GutenbergV2MediaBindingsRequest
  ): Promise<GutenbergV2MediaBindingsResponse> {
    const request = gutenbergV2MediaBindingsRequestSchema.parse(input);
    this.#assertSite(request.siteId);
    return gutenbergV2MediaBindingsResponseSchema.parse(
      await this.#post(endpointNames.mediaBindings, request)
    );
  }

  /**
   * Loads a page of the site as an anonymous visitor: no cookies or
   * signature, a cache-busting query so page caches don't answer, and at
   * most five redirects within the site's own origin.
   */
  public async checkPublicUrl(
    url: string
  ): Promise<{ status: number; finalUrl: string }> {
    let current = new URL(url);
    for (let hop = 0; hop <= 5; hop += 1) {
      if (current.origin !== this.#siteUrl.origin) {
        return { status: 0, finalUrl: current.toString() };
      }
      const probe = new URL(current);
      probe.searchParams.set("sitepilot_public_check", randomUUID());
      const response = await this.#fetch(probe, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html", "cache-control": "no-cache" }
      });
      await response.arrayBuffer().catch(() => undefined);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current);
        current.searchParams.delete("sitepilot_public_check");
        continue;
      }
      return { status: response.status, finalUrl: current.toString() };
    }
    return { status: 0, finalUrl: current.toString() };
  }

  /**
   * Hands one fixture result to the plugin, which repeats the save, data
   * and render checks and records the block's per-site status.
   */
  public async recordBlockFixture(
    result: GutenbergV2BlockFixtureResult
  ): Promise<GutenbergV2BlockFixtureStatus> {
    const request = {
      schemaVersion: "sitepilot.block-fixture/v2",
      blockName: result.blockName,
      schemaHash: result.schemaHash,
      serializedContent: result.serializedContent,
      reopenedContent: result.reopenedContent,
      editorIssues: result.issues.map((entry) => ({
        code: entry.code,
        message: entry.message
      }))
    };
    return gutenbergV2BlockFixtureStatusSchema.parse(
      await this.#post(endpointNames.blockFixtures, request)
    );
  }

  /** Read-only count of third-party blocks in the site's posts and pages. */
  public async readBlockUsage(): Promise<GutenbergV2BlockUsage> {
    return gutenbergV2BlockUsageSchema.parse(
      await this.#post(endpointNames.blockUsage, {
        schemaVersion: "sitepilot.block-usage-request/v2"
      })
    );
  }

  #assertSite(siteId: string): void {
    if (siteId !== this.#siteId) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "The WordPress v2 request site does not match transport configuration.",
        false
      );
    }
  }

  async #post(
    endpointName: (typeof endpointNames)[keyof typeof endpointNames],
    payload: unknown
  ): Promise<unknown> {
    const endpoint = new URL(
      `wp-json/sitepilot/v2/${endpointName}`,
      this.#siteUrl
    );
    if (endpoint.origin !== this.#siteUrl.origin) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "The WordPress v2 endpoint changed origin.",
        false
      );
    }
    const body = JSON.stringify(payload);
    const bodyBuffer = Buffer.from(body, "utf8");
    const signedHeaders = signSitePilotHmacRequest({
      method: "POST",
      path: `${endpoint.pathname}${endpoint.search}`,
      siteId: this.#siteId,
      clientId: this.#clientId,
      bodyBuffer,
      sharedSecret: this.#sharedSecret
    });
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          ...signedHeaders,
          "content-type": "application/json",
          accept: "application/json"
        }
      });
    } catch (error) {
      // No response: the request may or may not have reached WordPress, so
      // callers reconcile before any retry writes again.
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        timedOut
          ? "WordPress didn't answer a v2 request in time."
          : "Could not reach WordPress for a v2 request.",
        true,
        error
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "Signed WordPress v2 requests must not redirect.",
        false
      );
    }
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > 3_000_000) {
      throw new GutenbergV2WorkerError(
        "request_too_large",
        "The WordPress v2 response exceeded 3 MB.",
        false
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(responseBody);
    } catch (error) {
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        "WordPress returned invalid JSON for a v2 request.",
        true,
        error,
        [],
        response.status
      );
    }
    if (!response.ok) {
      throw workerErrorFromWordPress(
        response.status,
        decoded,
        `WordPress v2 request failed with HTTP ${response.status}.`
      );
    }
    return decoded;
  }
}
