import { app, ipcMain } from "electron";

import {
  ipcChannels,
  ipcContracts,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse
} from "@sitepilot/contracts";

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

  ipcMain.handle(ipcChannels.listWorkspaces, (_event, payload) => {
    parseRequest(ipcChannels.listWorkspaces, payload);

    return parseResponse(ipcChannels.listWorkspaces, {
      workspaces: [
        {
          id: "workspace-1",
          name: "Default Workspace",
          slug: "default-workspace"
        }
      ]
    });
  });

  ipcMain.handle(ipcChannels.listSites, (_event, payload) => {
    const request = parseRequest(ipcChannels.listSites, payload);

    return parseResponse(ipcChannels.listSites, {
      sites: [
        {
          id: "site-1",
          workspaceId: request.workspaceId ?? "workspace-1",
          name: "Example Production Site",
          baseUrl: "https://example.com",
          environment: "production",
          activationStatus: "config_required"
        }
      ]
    });
  });

  ipcMain.handle(ipcChannels.getProviderStatus, (_event, payload) => {
    parseRequest(ipcChannels.getProviderStatus, payload);

    return parseResponse(ipcChannels.getProviderStatus, {
      configuredProviders: []
    });
  });
}
