import { Buffer } from "node:buffer";

import {
  gutenbergV2EditorBootstrapResponseSchema,
  gutenbergV2EditorSessionRequestSchema,
  gutenbergV2EditorSessionResponseSchema,
  type GutenbergV2EditorBootstrapResponse,
  type GutenbergV2EditorSessionRequest,
  type GutenbergV2EditorSessionResponse
} from "@sitepilot/contracts";
import { signSitePilotHmacRequest } from "@sitepilot/plugin-protocol";
import type { BrowserContext } from "playwright";

import {
  GutenbergV2WorkerError,
  workerErrorFromWordPress
} from "./worker-error.js";

export interface GutenbergV2EditorSessionProvider {
  createSession(
    request: GutenbergV2EditorSessionRequest,
    options?: { signal?: AbortSignal }
  ): Promise<GutenbergV2EditorSessionResponse>;
  bootstrapSession(
    context: BrowserContext,
    session: GutenbergV2EditorSessionResponse
  ): Promise<GutenbergV2EditorBootstrapResponse>;
}

export type WordPressEditorSessionClientOptions = {
  siteUrl: string;
  siteId: string;
  clientId: string;
  sharedSecret: Buffer;
  endpointPath?: string;
  fetchImplementation?: typeof fetch;
};

function responseTextWithinLimit(
  response: Response,
  limit = 128_000
): Promise<string> {
  return response.text().then((value) => {
    if (Buffer.byteLength(value, "utf8") > limit) {
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        "The WordPress editor-session response exceeded its size limit.",
        true
      );
    }
    return value;
  });
}

function sameOrigin(expected: URL, candidate: string, label: string): URL {
  const parsed = new URL(candidate);
  if (parsed.origin !== expected.origin) {
    throw new GutenbergV2WorkerError(
      "permission_denied",
      `${label} must remain on the configured WordPress origin.`,
      false
    );
  }
  return parsed;
}

function wordpressFailure(
  text: string,
  status: number,
  fallbackMessage: string
): GutenbergV2WorkerError {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  return workerErrorFromWordPress(status, payload, fallbackMessage, {
    authStatusMeansPermissionDenied: true
  });
}

export class WordPressEditorSessionClient implements GutenbergV2EditorSessionProvider {
  readonly #siteUrl: URL;
  readonly #siteId: string;
  readonly #clientId: string;
  readonly #sharedSecret: Buffer;
  readonly #endpointPath: string | undefined;
  readonly #fetch: typeof fetch;

  public constructor(options: WordPressEditorSessionClientOptions) {
    this.#siteUrl = new URL(
      options.siteUrl.endsWith("/") ? options.siteUrl : `${options.siteUrl}/`
    );
    this.#siteId = options.siteId;
    this.#clientId = options.clientId;
    this.#sharedSecret = Buffer.from(options.sharedSecret);
    this.#endpointPath = options.endpointPath;
    this.#fetch = options.fetchImplementation ?? fetch;
    if (
      this.#endpointPath !== undefined &&
      (!this.#endpointPath.startsWith("/") ||
        this.#endpointPath.startsWith("//"))
    ) {
      throw new TypeError(
        "The editor-session endpoint must be an absolute path on the configured site."
      );
    }
  }

  public async createSession(
    request: GutenbergV2EditorSessionRequest,
    options?: { signal?: AbortSignal }
  ): Promise<GutenbergV2EditorSessionResponse> {
    const parsedRequest = gutenbergV2EditorSessionRequestSchema.parse(request);
    if (parsedRequest.siteId !== this.#siteId) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "The editor session site does not match worker configuration.",
        false
      );
    }
    const endpoint = new URL(
      this.#endpointPath ?? "wp-json/sitepilot/v2/editor-sessions",
      this.#siteUrl
    );
    sameOrigin(this.#siteUrl, endpoint.href, "Editor-session endpoint");
    const body = JSON.stringify(parsedRequest);
    const bodyBuffer = Buffer.from(body, "utf8");
    const headers = signSitePilotHmacRequest({
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
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json"
      }
    });
    if (response.status >= 300 && response.status < 400) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "Signed editor-session requests must not redirect.",
        false
      );
    }
    const text = await responseTextWithinLimit(response);
    if (!response.ok) {
      throw wordpressFailure(
        text,
        response.status,
        `WordPress rejected the editor-session request with HTTP ${response.status}.`
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        "WordPress returned invalid editor-session JSON.",
        true,
        error
      );
    }
    const session = gutenbergV2EditorSessionResponseSchema.parse(payload);
    sameOrigin(this.#siteUrl, session.bootstrapUrl, "Bootstrap URL");
    if (
      session.context.siteId !== this.#siteId ||
      session.context.executionId !== request.executionId
    ) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "The editor session response is bound to another execution.",
        false
      );
    }
    return session;
  }

  public async bootstrapSession(
    context: BrowserContext,
    session: GutenbergV2EditorSessionResponse
  ): Promise<GutenbergV2EditorBootstrapResponse> {
    const bootstrapUrl = sameOrigin(
      this.#siteUrl,
      session.bootstrapUrl,
      "Bootstrap URL"
    );
    const response = await context.request.post(bootstrapUrl.href, {
      data: { bootstrapToken: session.bootstrapToken },
      failOnStatusCode: false,
      maxRedirects: 0,
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      }
    });
    if (response.status() >= 300 && response.status() < 400) {
      throw new GutenbergV2WorkerError(
        "permission_denied",
        "Editor bootstrap must not redirect.",
        false
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 128_000) {
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        "The WordPress editor-bootstrap response exceeded its size limit.",
        true
      );
    }
    if (!response.ok()) {
      throw wordpressFailure(
        text,
        response.status(),
        `WordPress rejected editor bootstrap with HTTP ${response.status()}.`
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        "WordPress returned invalid editor-bootstrap JSON.",
        true,
        error
      );
    }
    const payload = gutenbergV2EditorBootstrapResponseSchema.parse(decoded);
    sameOrigin(this.#siteUrl, payload.editorUrl, "Editor URL");
    return payload;
  }
}
