import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import { ipcChannels, type IpcChannel } from "@sitepilot/contracts";
import { registerSharedIpcHandlers } from "@sitepilot/core/ipc-handlers";

import { readBody, send, sendJson } from "./http.js";

/**
 * The desktop app's interface, served to the browser, and the same IPC API
 * it uses in Electron at POST /api/ipc/:channel. One interface for both.
 */

/** Calls that only make sense on a desktop, or that change hosted setup. */
const DESKTOP_ONLY = new Set<string>([
  ipcChannels.registerSite,
  ipcChannels.exportBuildSiteBundle,
  ipcChannels.importApplySiteBundle,
  ipcChannels.settingsSetProviderSecret,
  ipcChannels.settingsClearProviderSecret,
  ipcChannels.settingsClearSiteSigningSecret,
  ipcChannels.settingsSetWordPressCoreSourcePath,
  ipcChannels.settingsChooseWordPressCoreSourcePath,
  ipcChannels.settingsReindexCoreBlocks
]);

/** Site setup and shared settings: only site admins change these here. */
const ADMIN_ONLY = new Set<string>([
  ipcChannels.generateSiteConfigDraft,
  ipcChannels.saveSiteConfig,
  ipcChannels.confirmSiteConfig,
  ipcChannels.refreshSiteDiscovery,
  ipcChannels.runSiteDiagnostics,
  ipcChannels.testAcfBlocks,
  ipcChannels.testThirdPartyBlocks,
  ipcChannels.settingsSetPlannerPreferences
]);

/** Deleting a thread removes other people's history too. */
const APPROVER_ONLY = new Set<string>([ipcChannels.deleteChatThread]);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8"
};

const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function createAppShell(input: { appVersion: string; directory?: string }) {
  const directory = resolve(
    input.directory ?? process.env.SITEPILOT_APP_DIR ?? join(process.cwd(), "apps/desktop/dist/renderer")
  );
  const handlers = new Map<string, (payload: unknown) => unknown>();
  registerSharedIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    appVersion: input.appVersion
  });

  return {
    available: existsSync(join(directory, "index.html")),

    /** The interface's index page and its built assets. */
    serveFile(response: ServerResponse, path: string): boolean {
      const relative = path === "/" || path === "/index.html" ? "index.html" : path.replace(/^\/+/, "");
      const file = normalize(join(directory, relative));
      if (!file.startsWith(directory + sep) || !existsSync(file) || !extname(file)) return false;
      send(response, 200, readFileSync(file), {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        ...(relative === "index.html"
          ? { "content-security-policy": APP_CSP, "cache-control": "no-store" }
          : { "cache-control": "public, max-age=31536000, immutable" })
      });
      return true;
    },

    /** Run in the signed-in user's call context; the services check approve rights. */
    async handleIpc(
      request: IncomingMessage,
      response: ServerResponse,
      channel: string,
      user: { appRole: string; siteRoles: readonly string[] }
    ): Promise<void> {
      const handler = handlers.get(channel);
      if (!handler || DESKTOP_ONLY.has(channel)) {
        sendJson(response, 404, {
          ok: false,
          code: "not_available",
          message: "That's only available in the desktop app."
        });
        return;
      }
      if (
        (ADMIN_ONLY.has(channel) && user.appRole !== "admin") ||
        (APPROVER_ONLY.has(channel) && !user.siteRoles.includes("approve"))
      ) {
        sendJson(response, 403, {
          ok: false,
          code: "forbidden",
          message: "Your WordPress role doesn't allow that."
        });
        return;
      }
      let payload: unknown;
      try {
        const text = await readBody(request, 30_000_000);
        payload = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        sendJson(response, 400, { ok: false, code: "schema_invalid", message: "Invalid request." });
        return;
      }
      try {
        sendJson(response, 200, await handler(payload));
      } catch (error) {
        console.log(`App call ${channel} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        // The interface reads every answer as { ok, ... }.
        sendJson(response, 500, { ok: false, code: "internal_error", message: "SitePilot hit an error. Try again." });
      }
    }
  };
}

export type AppShell = ReturnType<typeof createAppShell>;
export type { IpcChannel };
