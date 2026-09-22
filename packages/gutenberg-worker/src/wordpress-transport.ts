import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
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
  gutenbergV2ValidationFailureCodeSchema,
  type GutenbergV2CommitReceipt,
  type GutenbergV2MediaBindingsRequest,
  type GutenbergV2MediaBindingsResponse,
  type GutenbergV2PrepareCommitRequest,
  type GutenbergV2PrepareCommitResponse,
  type GutenbergV2Readback,
  type GutenbergV2RecoverResponse,
  type GutenbergV2SourceSnapshot
} from "@sitepilot/contracts";
import { signSitePilotHmacRequest } from "@sitepilot/plugin-protocol";
import type {
  GutenbergV2MediaBindingTransport,
  GutenbergV2WordPressTransport
} from "@sitepilot/services";

import { GutenbergV2WorkerError } from "./worker-error.js";

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
};

const endpointNames = {
  prepare: "prepare",
  commit: "commit",
  reconcile: "reconcile",
  readback: "readback",
  recover: "recover",
  mediaBindings: "media-bindings"
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

  public constructor(options: SignedWordPressV2TransportOptions) {
    this.#siteUrl = new URL(
      options.siteUrl.endsWith("/") ? options.siteUrl : `${options.siteUrl}/`
    );
    this.#siteId = options.siteId;
    this.#clientId = options.clientId;
    this.#sharedSecret = Buffer.from(options.sharedSecret);
    this.#sourceReader = options.sourceReader;
    this.#fetch = options.fetchImplementation ?? fetch;
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
    const response = await this.#fetch(endpoint, {
      method: "POST",
      body,
      redirect: "manual",
      headers: {
        ...signedHeaders,
        "content-type": "application/json",
        accept: "application/json"
      }
    });
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
        error
      );
    }
    if (!response.ok) {
      const record =
        decoded !== null &&
        typeof decoded === "object" &&
        !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>)
          : {};
      const data =
        record.data !== null &&
        typeof record.data === "object" &&
        !Array.isArray(record.data)
          ? (record.data as Record<string, unknown>)
          : {};
      const code = typeof data.code === "string" ? data.code : undefined;
      const parsedCode = gutenbergV2ValidationFailureCodeSchema.safeParse(code);
      const failureCode =
        code === "prepared_commit_changed"
          ? "idempotency_conflict"
          : parsedCode.success
            ? parsedCode.data
            : "editor_unavailable";
      const retryable =
        response.status >= 500 || failureCode === "editor_unavailable";
      throw new GutenbergV2WorkerError(
        failureCode,
        typeof record.message === "string"
          ? record.message
          : `WordPress v2 request failed with HTTP ${response.status}.`,
        retryable
      );
    }
    return decoded;
  }
}
