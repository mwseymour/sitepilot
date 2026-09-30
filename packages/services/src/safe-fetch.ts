import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Fetches a URL that came from outside SitePilot: a user's message, a model's
 * output or a third-party API. It refuses loopback, private, link-local and
 * other non-public addresses, directly or through a redirect, and connects to
 * the address it checked so a second DNS answer can't swap it (DNS rebinding).
 */

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type SafeFetchOptions = {
  /** Largest body to read, in bytes. */
  maxBytes: number;
  /** Time allowed for each request, in milliseconds. */
  timeoutMs: number;
  /** Also allow plain http. Addresses are checked either way. */
  allowHttp?: boolean;
  /** Redirects to follow, each one checked again. Defaults to 3. */
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Resolves a host name. Tests replace it. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Decides which resolved addresses may be contacted. Tests replace it. */
  isAllowedAddress?: (address: string) => boolean;
};

export type SafeFetchResponse = {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type SafeFetchErrorCode =
  | "invalid_url"
  | "scheme_not_allowed"
  | "address_not_allowed"
  | "dns_failed"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 addresses embed an IPv4 address. IPv4-mapped addresses are handled
  // in isPublicAddress: a ::ffff:0:0/96 rule here would also match every
  // plain IPv4 address.
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** True for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // ::ffff:a.b.c.d (or its hex form) is the IPv4 address a.b.c.d.
    const mapped = /^::ffff:(?:0:)?((?:\d{1,3}\.){3}\d{1,3})$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^::ffff:(?:0:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(address)) return false;
  }
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4
  }));
}

function parseAllowedUrl(value: string, options: SafeFetchOptions): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeFetchError("invalid_url", "That link is not a valid URL.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && options.allowHttp === true) return url;
  throw new SafeFetchError(
    "scheme_not_allowed",
    options.allowHttp === true
      ? "Only http and https links are supported."
      : "Only https links are supported."
  );
}

async function resolveAllowed(
  hostname: string,
  options: SafeFetchOptions
): Promise<ResolvedAddress> {
  const isAllowed = options.isAllowedAddress ?? isPublicAddress;
  const literal = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literal !== 0) {
    addresses = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await (options.resolve ?? defaultResolve)(hostname);
    } catch {
      throw new SafeFetchError("dns_failed", `Could not look up ${hostname}.`);
    }
  }
  if (addresses.length === 0) {
    throw new SafeFetchError("dns_failed", `Could not look up ${hostname}.`);
  }
  // Every answer must be allowed, so a name can't pair a public address with
  // a private one.
  const blocked = addresses.find((entry) => !isAllowed(entry.address));
  if (blocked) {
    throw new SafeFetchError(
      "address_not_allowed",
      `${hostname} points to a private or local address, which SitePilot won't fetch.`
    );
  }
  return addresses[0]!;
}

function flattenHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function fetchOnce(
  url: URL,
  pinned: ResolvedAddress,
  options: SafeFetchOptions
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Connect to the address that was checked, whatever DNS says next.
  const lookup: LookupFunction = (_host, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [pinned]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: SafeFetchError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new SafeFetchError("timeout", `${hostname} took too long to respond.`));
    }, options.timeoutMs);

    const request = send(
      {
        protocol: url.protocol,
        hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "user-agent": "SitePilot", ...options.headers },
        lookup,
        ...(isIP(hostname) === 0 ? { servername: hostname } : {})
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = flattenHeaders(response);
        if (REDIRECT_STATUSES.has(status)) {
          response.resume();
          settled = true;
          clearTimeout(timer);
          resolve({ status, headers, body: Buffer.alloc(0) });
          return;
        }
        const declared = Number(headers["content-length"] ?? "0");
        if (declared > options.maxBytes) {
          fail(new SafeFetchError("too_large", "That page is too large to fetch."));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) {
            fail(new SafeFetchError("too_large", "That page is too large to fetch."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, headers, body: Buffer.concat(chunks) });
        });
        response.on("error", () => {
          fail(new SafeFetchError("network", `The connection to ${hostname} failed.`));
        });
      }
    );
    request.on("error", () => {
      fail(new SafeFetchError("network", `Could not connect to ${hostname}.`));
    });
    request.end();
  });
}

export async function safeFetch(
  input: string,
  options: SafeFetchOptions
): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? 3;
  let url = parseAllowedUrl(input, options);
  for (let redirects = 0; ; redirects += 1) {
    const pinned = await resolveAllowed(url.hostname.replace(/^\[|\]$/g, ""), options);
    const response = await fetchOnce(url, pinned, options);
    const location = response.headers["location"];
    if (!REDIRECT_STATUSES.has(response.status) || location === undefined) {
      return { url: url.toString(), ...response };
    }
    if (redirects >= maxRedirects) {
      throw new SafeFetchError("too_many_redirects", "That link redirects too many times.");
    }
    // Each hop is checked like the first: scheme, then every address.
    url = parseAllowedUrl(new URL(location, url).toString(), options);
  }
}
