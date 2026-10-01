import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAppShell } from "../apps/server/src/app-shell.js";

let server: Server | undefined;
let directory: string | undefined;

async function start(user: { appRole: string; siteRoles: string[] }): Promise<string> {
  directory = mkdtempSync(join(tmpdir(), "sitepilot-app-shell-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(directory, "assets", "index-abc.js"), "console.log(1)");
  const app = createAppShell({ appVersion: "0.1.0", directory });
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/api/ipc/")) {
      void app.handleIpc(request, response, path.slice("/api/ipc/".length), user);
    } else if (!app.serveFile(response, path)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("the hosted app shell", () => {
  it("serves the desktop interface's build, and nothing outside it", async () => {
    const base = await start({ appRole: "admin", siteRoles: ["read", "request", "approve"] });
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(index.headers.get("cache-control")).toBe("no-store");
    const asset = await fetch(`${base}/assets/index-abc.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/assets/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it("refuses desktop-only calls, and setup calls from people who aren't admins", async () => {
    const base = await start({ appRole: "requester", siteRoles: ["read", "request"] });
    const call = (channel: string) =>
      fetch(`${base}/api/ipc/${channel}`, { method: "POST", body: "{}" }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as { code: string }
      }));
    expect(await call("site.register")).toMatchObject({ status: 404, body: { code: "not_available" } });
    expect(await call("settings.setProviderSecret")).toMatchObject({ status: 404 });
    expect(await call("mcpServer.getState")).toMatchObject({ status: 404 });
    expect(await call("not.aChannel")).toMatchObject({ status: 404 });
    expect(await call("site.confirmConfig")).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await call("chat.deleteThread")).toMatchObject({ status: 403, body: { code: "forbidden" } });
  });
});
