import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

const insecureLoopbackHttpsAgent = new HttpsAgent({
  rejectUnauthorized: false
});

/** Longest a site request may take when the caller doesn't set its own signal. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Largest response read on the local-development path, in bytes. */
const MAX_LOOPBACK_RESPONSE_BYTES = 32 * 1024 * 1024;

function getRequestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function shouldBypassTlsVerification(url: URL): boolean {
  return url.protocol === "https:" && isLoopbackHostname(url.hostname);
}

/** True when local-development TLS relaxation applies to this site URL. */
export function isLoopbackHttpsSiteUrl(siteUrl: string): boolean {
  try {
    return shouldBypassTlsVerification(new URL(siteUrl));
  } catch {
    return false;
  }
}

function loopbackLookup(hostname: string): LookupFunction | undefined {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return (_target, optionsOrCallback, callback) => {
      const options =
        typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const done =
        typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      if (!done) {
        return;
      }
      if (options?.all) {
        done(null, [{ address: "127.0.0.1", family: 4 }]);
        return;
      }
      done(null, "127.0.0.1", 4);
    };
  }
  return undefined;
}

async function readRequestBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  return Buffer.from(await new Response(body as Blob).arrayBuffer());
}

function createAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

export async function fetchSiteUrl(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = getRequestUrl(input);
  const signal = init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  if (!shouldBypassTlsVerification(url)) {
    return fetch(input, { ...init, signal });
  }

  const body = await readRequestBody(init?.body);
  const headers = new Headers(init?.headers);
  if (body.length > 0 && !headers.has("content-length")) {
    headers.set("content-length", String(body.length));
  }

  return await new Promise<Response>((resolve, reject) => {
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    const req = requestImpl(
      url,
      {
        method: init?.method ?? "GET",
        headers: requestHeaders,
        agent: url.protocol === "https:" ? insecureLoopbackHttpsAgent : undefined,
        lookup: loopbackLookup(url.hostname)
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer | string) => {
          const bytes =
            typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
          received += bytes.length;
          if (received > MAX_LOOPBACK_RESPONSE_BYTES) {
            req.destroy(new Error("The site's response was too large."));
            return;
          }
          chunks.push(bytes);
        });
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) {
                responseHeaders.append(key, item);
              }
            } else if (value !== undefined) {
              responseHeaders.set(key, value);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders
            })
          );
        });
      }
    );

    req.on("error", reject);

    if (signal.aborted) {
      req.destroy(createAbortError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        req.destroy(createAbortError());
      },
      { once: true }
    );

    if (body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}
