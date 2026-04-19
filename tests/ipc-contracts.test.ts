import { describe, expect, it } from "vitest";

import {
  ipcChannels,
  ipcContracts,
  shellInfoResponseSchema,
  type IpcResponse,
  type SitePilotDesktopApi,
  type SiteRegistration
} from "@sitepilot/contracts";

describe("ipc contracts", () => {
  it("defines typed channels with request and response schemas", () => {
    const request = ipcContracts[ipcChannels.listSites].request.parse({
      workspaceId: "workspace-1"
    });
    const response: IpcResponse<typeof ipcChannels.listSites> = ipcContracts[
      ipcChannels.listSites
    ].response.parse({
      sites: [
        {
          id: "site-1",
          workspaceId: request.workspaceId,
          name: "Example Site",
          baseUrl: "https://example.com",
          environment: "production",
          activationStatus: "active"
        }
      ]
    });

    expect(response.sites[0]?.name).toBe("Example Site");
  });

  it("matches the preload bridge API shape", async () => {
    const registration: SiteRegistration = {
      siteId: "site-1",
      workspaceId: "ws-1",
      trustedAppOrigin: "https://sitepilot.desktop",
      clientIdentifier: "client-1",
      protocolVersion: "1.0.0",
      pluginVersion: "0.1.0",
      createdAt: "2026-04-19T12:00:00.000Z",
      status: "verified",
      credential: {
        algorithm: "hmac_sha256",
        sharedSecretFingerprint: "a".repeat(64)
      }
    };

    const api: SitePilotDesktopApi = {
      getShellInfo: async () =>
        shellInfoResponseSchema.parse({
          appName: "SitePilot",
          appVersion: "0.1.0",
          rendererVersion: "0.1.0"
        }),
      listWorkspaces: async () => ({ workspaces: [] }),
      listSites: async () => ({ sites: [] }),
      registerSite: async () => ({
        ok: true,
        site: {
          id: "site-1",
          workspaceId: "ws-1",
          name: "Example",
          baseUrl: "https://example.com",
          environment: "production",
          activationStatus: "config_required"
        },
        registration,
        mcpToolCount: 2
      }),
      runSiteDiagnostics: async () => ({
        siteId: "site-1",
        checkedAt: "2026-04-19T12:00:00.000Z",
        overallOk: true,
        checks: {
          health: { ok: true, httpStatus: 200, latencyMs: 10 },
          protocolMetadata: {
            ok: true,
            protocolVersion: "1.0.0",
            pluginVersion: "0.1.0",
            compatibilityOk: true,
            latencyMs: 5
          },
          authentication: { ok: true },
          mcpTools: { ok: true, toolNames: ["sitepilot/ping"] },
          pluginVersion: { ok: true, version: "0.1.0" }
        }
      }),
      refreshSiteDiscovery: async () => ({
        ok: true,
        snapshot: {
          id: "snap-1",
          siteId: "site-1",
          revision: 1,
          warnings: [],
          capabilities: ["sitepilot/ping"],
          summary: { discovery: {} },
          createdAt: "2026-04-19T12:00:00.000Z",
          updatedAt: "2026-04-19T12:00:00.000Z"
        }
      }),
      generateSiteConfigDraft: async () => ({
        ok: false,
        code: "discovery_missing",
        message: "Run discovery before generating a site config draft."
      }),
      getSiteWorkspace: async () => ({
        ok: true,
        site: {
          id: "site-1",
          workspaceId: "ws-1",
          name: "Example",
          baseUrl: "https://example.com",
          environment: "production",
          activationStatus: "config_required"
        },
        siteConfig: null,
        discoveryRevision: null
      }),
      saveSiteConfig: async () => ({
        ok: false,
        code: "stub",
        message: "Not used in this contract shape test."
      }),
      confirmSiteConfig: async () => ({
        ok: false,
        code: "stub",
        message: "Not used in this contract shape test."
      }),
      getProviderStatus: async () => ({ configuredProviders: [] })
    };

    await expect(api.getShellInfo()).resolves.toMatchObject({
      appName: "SitePilot"
    });
    await expect(
      api.registerSite({
        baseUrl: "https://example.com",
        registrationCode: "x",
        siteName: "Example"
      })
    ).resolves.toMatchObject({ ok: true });
  });
});
