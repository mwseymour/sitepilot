import { signSitePilotHmacRequest } from "@sitepilot/plugin-protocol";
import { fetchSiteUrl } from "./site-fetch.js";

export type SignedFetchOptions = {
  sharedSecret: Buffer;
  siteId: string;
  clientId: string;
};

/**
 * Wraps `fetch` so every request carries SitePilot HMAC headers for
 * WordPress MCP (`/wp-json/sitepilot/mcp`).
 */
export function createSignedMcpFetch(
  options: SignedFetchOptions
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const urlObj = new URL(url);
    const path = `${urlObj.pathname}${urlObj.search}`;
    const method = (init?.method ?? "GET").toUpperCase();
    let bodyBuffer = Buffer.alloc(0);
    const body = init?.body;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        bodyBuffer = Buffer.from(body, "utf8");
      } else if (Buffer.isBuffer(body)) {
        bodyBuffer = Buffer.from(body);
      } else if (body instanceof ArrayBuffer) {
        bodyBuffer = Buffer.from(body);
      } else if (typeof Blob !== "undefined" && body instanceof Blob) {
        bodyBuffer = Buffer.from(await body.arrayBuffer());
      } else if (body instanceof Uint8Array) {
        bodyBuffer = Buffer.from(body);
      } else {
        bodyBuffer = Buffer.from(
          await new Response(body as Blob).arrayBuffer()
        );
      }
    }
    const signed = signSitePilotHmacRequest({
      method,
      path,
      siteId: options.siteId,
      clientId: options.clientId,
      bodyBuffer,
      sharedSecret: options.sharedSecret
    });
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(signed)) {
      merged.set(key, value);
    }
    return fetchSiteUrl(input, { ...init, headers: merged });
  };
}
