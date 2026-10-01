import type { IncomingMessage, ServerResponse } from "node:http";

/** Small helpers over node:http; the server needs nothing heavier. */

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY"
} as const;

export async function readBody(
  request: IncomingMessage,
  limit = 1_000_000
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request, 100_000));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore a malformed cookie rather than failing the request.
    }
  }
  return cookies;
}

/** HttpOnly, SameSite=Lax, and Secure whenever the server is on https. */
export function cookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean }
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ["Secure"] : [])
  ].join("; ");
}

export function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string | string[]> = {}
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    ...headers
  });
  response.end(body);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8"
  });
}

export function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
  cookies: string[] = []
): void {
  send(response, status, body, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {})
  });
}

export function redirect(
  response: ServerResponse,
  location: string,
  cookies: string[] = []
): void {
  response.writeHead(303, {
    ...SECURITY_HEADERS,
    location,
    "cache-control": "no-store",
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {})
  });
  response.end();
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Form posts must come from this server's own pages. Together with
 * SameSite=Lax session cookies this stops cross-site form posts.
 */
export function isSameOrigin(request: IncomingMessage, publicUrl: URL): boolean {
  const origin = request.headers.origin;
  if (origin) return origin === publicUrl.origin;
  const referer = request.headers.referer;
  if (!referer) return false;
  try {
    return new URL(referer).origin === publicUrl.origin;
  } catch {
    return false;
  }
}
