import { contextBridge, ipcRenderer } from "electron";

import {
  ipcChannels,
  ipcContracts,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type SitePilotDesktopApi
} from "@sitepilot/contracts";

async function invokeIpc<TChannel extends IpcChannel>(
  channel: TChannel,
  payload: IpcRequest<TChannel>
): Promise<IpcResponse<TChannel>> {
  const request = ipcContracts[channel].request.parse(payload);
  const response = await ipcRenderer.invoke(channel, request);

  return ipcContracts[channel].response.parse(response);
}

const desktopApi: SitePilotDesktopApi = {
  getShellInfo: () => invokeIpc(ipcChannels.getShellInfo, {}),
  listWorkspaces: () => invokeIpc(ipcChannels.listWorkspaces, {}),
  listSites: (request = {}) => invokeIpc(ipcChannels.listSites, request),
  getProviderStatus: () => invokeIpc(ipcChannels.getProviderStatus, {})
};

contextBridge.exposeInMainWorld("sitePilotDesktop", desktopApi);
