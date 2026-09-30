import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRequestHandler,
  serverInfoFromEnvironment
} from "@sitepilot/server";

let server: Server | undefined;

async function start(): Promise<string> {
  server = createServer(
    createRequestHandler(
      serverInfoFromEnvironment(
        {
          RAILWAY_GIT_COMMIT_SHA: "0123456789abcdef",
          RAILWAY_REPLICA_REGION: "europe-west4"
        },
        new Date("2026-09-30T12:00:00.000Z")
      )
    )
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("SitePilot server", () => {
  it("answers the health check with the deployed commit", async () => {
    const response = await fetch(`${await start()}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "sitepilot-server",
      version: "0.1.0",
      commit: "0123456",
      region: "europe-west4",
      startedAt: "2026-09-30T12:00:00.000Z"
    });
  });

  it("refuses other routes with sitepilot.error/v1", async () => {
    const base = await start();
    const missing = await fetch(`${base}/mcp`, { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "not_found",
      retryable: false
    });
    expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(404);
  });
});
