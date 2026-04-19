import { app, ipcMain } from "electron";

import {
  ipcChannels,
  ipcContracts,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse
} from "@sitepilot/contracts";
import type { Workspace } from "@sitepilot/domain";

import { runConnectivityDiagnostics } from "./connectivity-diagnostics.js";
import { getDatabase } from "./app-database.js";
import { refreshDiscoveryForSite } from "./discovery-service.js";
import { registerSiteWithWordPress } from "./register-site.js";

function parseRequest<TChannel extends IpcChannel>(
  channel: TChannel,
  payload: unknown
): IpcRequest<TChannel> {
  return ipcContracts[channel].request.parse(payload);
}

function parseResponse<TChannel extends IpcChannel>(
  channel: TChannel,
  payload: unknown
): IpcResponse<TChannel> {
  return ipcContracts[channel].response.parse(payload);
}

export function registerIpcHandlers(): void {
  ipcMain.handle(ipcChannels.getShellInfo, (_event, payload) => {
    parseRequest(ipcChannels.getShellInfo, payload);

    return parseResponse(ipcChannels.getShellInfo, {
      appName: "SitePilot",
      appVersion: app.getVersion(),
      rendererVersion: "0.1.0"
    });
  });

  ipcMain.handle(ipcChannels.listWorkspaces, async (_event, payload) => {
    parseRequest(ipcChannels.listWorkspaces, payload);

    const db = getDatabase();
    const workspaces = await db.repositories.workspaces.list();

    return parseResponse(ipcChannels.listWorkspaces, {
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug
      }))
    });
  });

  ipcMain.handle(ipcChannels.listSites, async (_event, payload) => {
    const request = parseRequest(ipcChannels.listSites, payload);

    const db = getDatabase();
    const workspaceId = (request.workspaceId ??
      "workspace-1") as Workspace["id"];
    const sites = await db.repositories.sites.listByWorkspaceId(workspaceId);

    return parseResponse(ipcChannels.listSites, {
      sites: sites.map((s) => ({
        id: s.id,
        workspaceId: s.workspaceId,
        name: s.name,
        baseUrl: s.baseUrl,
        environment: s.environment,
        activationStatus: s.activationStatus
      }))
    });
  });

  ipcMain.handle(ipcChannels.runSiteDiagnostics, async (_event, payload) => {
    const request = parseRequest(ipcChannels.runSiteDiagnostics, payload);
    const result = await runConnectivityDiagnostics(request.siteId);
    return parseResponse(ipcChannels.runSiteDiagnostics, result);
  });

  ipcMain.handle(ipcChannels.refreshSiteDiscovery, async (_event, payload) => {
    const request = parseRequest(ipcChannels.refreshSiteDiscovery, payload);
    const result = await refreshDiscoveryForSite(request.siteId);
    return parseResponse(ipcChannels.refreshSiteDiscovery, result);
  });

  ipcMain.handle(ipcChannels.registerSite, async (_event, payload) => {
    const request = parseRequest(ipcChannels.registerSite, payload);
    const forward: Parameters<typeof registerSiteWithWordPress>[0] = {
      baseUrl: request.baseUrl,
      registrationCode: request.registrationCode,
      siteName: request.siteName
    };
    if (request.workspaceId !== undefined) {
      forward.workspaceId = request.workspaceId;
    }
    if (request.environment !== undefined) {
      forward.environment = request.environment;
    }
    if (request.trustedAppOrigin !== undefined) {
      forward.trustedAppOrigin = request.trustedAppOrigin;
    }
    const result = await registerSiteWithWordPress(forward);
    return parseResponse(ipcChannels.registerSite, result);
  });

  ipcMain.handle(ipcChannels.getProviderStatus, (_event, payload) => {
    parseRequest(ipcChannels.getProviderStatus, payload);

    return parseResponse(ipcChannels.getProviderStatus, {
      configuredProviders: []
    });
  });
}
