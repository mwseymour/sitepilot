import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isPublicAddress,
  safeFetch,
  SafeFetchError,
  type ResolvedAddress,
  type SafeFetchOptions
} from "../packages/services/src/safe-fetch.js";

let server: Server;
let port = 0;
let connections = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/page") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Hi</title><p>Hello</p>");
    } else if (path.startsWith("/redirect/")) {
      const remaining = Number(path.split("/")[2]);
      response.writeHead(302, {
        location: remaining > 0 ? `/redirect/${remaining - 1}` : "/page"
      });
      response.end();
    } else if (path === "/to-internal") {
      response.writeHead(302, { location: `http://internal.test:${port}/page` });
      response.end();
    } else if (path === "/big") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(5_000));
    } else if (path === "/slow") {
      setTimeout(() => {
        response.writeHead(200);
        response.end("late");
      }, 500);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * "site.test" resolves to the local server, which the test treats as a public
 * address. "internal.test" resolves to a private address.
 */
function testOptions(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    allowHttp: true,
    maxBytes: 1_000,
    timeoutMs: 2_000,
    resolve: async (hostname): Promise<ResolvedAddress[]> =>
      hostname === "site.test"
        ? [{ address: "127.0.0.1", family: 4 }]
        : hostname === "internal.test"
          ? [{ address: "10.0.0.5", family: 4 }]
          : [],
    isAllowedAddress: (address) => address === "127.0.0.1" || isPublicAddress(address),
    ...overrides
  };
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error.code;
    throw error;
  }
  throw new Error("Expected the fetch to fail.");
}

describe("isPublicAddress", () => {
  it("refuses loopback, private, link-local, metadata and other non-public ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "not-an-ip"
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("allows public addresses", () => {
    for (const address of [
      "93.184.216.34",
      "1.1.1.1",
      "::ffff:93.184.216.34",
      "2606:4700:4700::1111"
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe("safeFetch", () => {
  it("fetches a page", async () => {
    const response = await safeFetch(`http://site.test:${port}/page`, testOptions());
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.body.toString("utf8")).toContain("Hello");
  });

  it("refuses a literal loopback address with the default rule", async () => {
    expect(
      await failureCode(
        safeFetch(`http://127.0.0.1:${port}/page`, {
          allowHttp: true,
          maxBytes: 1_000,
          timeoutMs: 2_000
        })
      )
    ).toBe("address_not_allowed");
  });

  it("refuses a redirect to a private address", async () => {
    expect(
      await failureCode(safeFetch(`http://site.test:${port}/to-internal`, testOptions()))
    ).toBe("address_not_allowed");
  });

  it("follows up to three redirects and refuses more", async () => {
    const followed = await safeFetch(`http://site.test:${port}/redirect/2`, testOptions());
    expect(followed.url).toBe(`http://site.test:${port}/page`);
    expect(
      await failureCode(safeFetch(`http://site.test:${port}/redirect/5`, testOptions()))
    ).toBe("too_many_redirects");
  });

  it("refuses a body larger than the cap", async () => {
    expect(await failureCode(safeFetch(`http://site.test:${port}/big`, testOptions()))).toBe(
      "too_large"
    );
  });

  it("gives up on a slow response", async () => {
    expect(
      await failureCode(
        safeFetch(`http://site.test:${port}/slow`, testOptions({ timeoutMs: 100 }))
      )
    ).toBe("timeout");
  });

  it("refuses plain http unless it is allowed", async () => {
    expect(
      await failureCode(
        safeFetch(`http://site.test:${port}/page`, testOptions({ allowHttp: false }))
      )
    ).toBe("scheme_not_allowed");
    expect(await failureCode(safeFetch("file:///etc/passwd", testOptions()))).toBe(
      "scheme_not_allowed"
    );
  });

  it("refuses a name that mixes a public and a private answer", async () => {
    expect(
      await failureCode(
        safeFetch(
          `http://site.test:${port}/page`,
          testOptions({
            resolve: async () => [
              { address: "127.0.0.1", family: 4 },
              { address: "10.0.0.5", family: 4 }
            ]
          })
        )
      )
    ).toBe("address_not_allowed");
  });

  it("looks the name up once and connects to that address (DNS rebinding)", async () => {
    let lookups = 0;
    const before = connections;
    const response = await safeFetch(
      `http://site.test:${port}/page`,
      testOptions({
        resolve: async () => {
          lookups += 1;
          // A second lookup would point somewhere private.
          return lookups === 1
            ? [{ address: "127.0.0.1", family: 4 }]
            : [{ address: "10.0.0.5", family: 4 }];
        }
      })
    );
    expect(response.status).toBe(200);
    expect(lookups).toBe(1);
    expect(connections - before).toBe(1);
  });
});
