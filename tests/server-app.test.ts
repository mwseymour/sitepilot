import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRequestHandler,
  serverInfoFromEnvironment
} from "@sitepilot/server";
import { poolConfigFromEnvironment } from "../apps/server/src/database.js";

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
      startedAt: "2026-09-30T12:00:00.000Z",
      database: { status: "not_configured" },
      secrets: "not_configured"
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

describe("database settings", () => {
  it("is off without connection settings", () => {
    expect(poolConfigFromEnvironment({})).toBeNull();
  });

  it("skips TLS for a local or Railway-internal database", () => {
    expect(poolConfigFromEnvironment({ PGHOST: "127.0.0.1" })?.tls).toBe("off");
    expect(
      poolConfigFromEnvironment({ PGHOST: "postgres.railway.internal" })?.tls
    ).toBe("off");
  });

  it("encrypts a remote database, and verifies it with a CA certificate", () => {
    const unverified = poolConfigFromEnvironment({
      PGHOST: "aws-1-eu-central-1.pooler.supabase.com"
    });
    expect(unverified?.tls).toBe("encrypted_unverified");
    expect(unverified?.config.ssl).toEqual({ rejectUnauthorized: false });

    const verified = poolConfigFromEnvironment({
      DATABASE_URL:
        "postgresql://user@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
      SITEPILOT_PG_CA_CERT: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"
    });
    expect(verified?.tls).toBe("verified");
    expect(verified?.config.ssl).toMatchObject({ rejectUnauthorized: true });
  });
});

describe("health while the database connects", () => {
  it("stays 200 and reports the attempt count, not the error", async () => {
    server = createServer(
      createRequestHandler(serverInfoFromEnvironment({}), () => ({
        status: "connecting",
        attempts: 3,
        lastError: "password authentication failed"
      }))
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const response = await fetch(
      `http://127.0.0.1:${(server!.address() as AddressInfo).port}/healthz`
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { database: unknown };
    expect(body.database).toEqual({ status: "connecting", attempts: 3 });
  });
});
