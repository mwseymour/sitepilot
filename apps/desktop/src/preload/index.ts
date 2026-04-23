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
  registerSite: (request) => invokeIpc(ipcChannels.registerSite, request),
  runSiteDiagnostics: (request) =>
    invokeIpc(ipcChannels.runSiteDiagnostics, request),
  refreshSiteDiscovery: (request) =>
    invokeIpc(ipcChannels.refreshSiteDiscovery, request),
  generateSiteConfigDraft: (request) =>
    invokeIpc(ipcChannels.generateSiteConfigDraft, request),
  getSiteWorkspace: (request) =>
    invokeIpc(ipcChannels.getSiteWorkspace, request),
  saveSiteConfig: (request) => invokeIpc(ipcChannels.saveSiteConfig, request),
  confirmSiteConfig: (request) =>
    invokeIpc(ipcChannels.confirmSiteConfig, request),
  listChatThreads: (request) => invokeIpc(ipcChannels.listChatThreads, request),
  createChatThread: (request) =>
    invokeIpc(ipcChannels.createChatThread, request),
  renameChatThread: (request) =>
    invokeIpc(ipcChannels.renameChatThread, request),
  deleteChatThread: (request) =>
    invokeIpc(ipcChannels.deleteChatThread, request),
  listChatMessages: (request) =>
    invokeIpc(ipcChannels.listChatMessages, request),
  postChatMessage: (request) => invokeIpc(ipcChannels.postChatMessage, request),
  createChatRequest: (request) =>
    invokeIpc(ipcChannels.createChatRequest, request),
  amendRequest: (request) => invokeIpc(ipcChannels.amendRequest, request),
  answerClarification: (request) =>
    invokeIpc(ipcChannels.answerClarification, request),
  buildPlannerContext: (request) =>
    invokeIpc(ipcChannels.buildPlannerContext, request),
  generateActionPlan: (request) =>
    invokeIpc(ipcChannels.generateActionPlan, request),
  listPendingApprovals: (request) =>
    invokeIpc(ipcChannels.listPendingApprovals, request),
  decideApproval: (request) => invokeIpc(ipcChannels.decideApproval, request),
  listAuditEntries: (request) =>
    invokeIpc(ipcChannels.listAuditEntries, request),
  getRequestBundle: (request) =>
    invokeIpc(ipcChannels.getRequestBundle, request),
  executePlanAction: (request) =>
    invokeIpc(ipcChannels.executePlanAction, request),
  getProviderStatus: () => invokeIpc(ipcChannels.getProviderStatus, {}),
  getSettingsState: (request = {}) =>
    invokeIpc(ipcChannels.settingsGetState, request),
  setProviderSecret: (request) =>
    invokeIpc(ipcChannels.settingsSetProviderSecret, request),
  clearProviderSecret: (request) =>
    invokeIpc(ipcChannels.settingsClearProviderSecret, request),
  setPlannerPreferences: (request) =>
    invokeIpc(ipcChannels.settingsSetPlannerPreferences, request),
  setSitePlannerSettings: (request) =>
    invokeIpc(ipcChannels.settingsSetSitePlannerSettings, request),
  setUiPreferences: (request) =>
    invokeIpc(ipcChannels.settingsSetUiPreferences, request),
  clearSiteSigningSecret: (request) =>
    invokeIpc(ipcChannels.settingsClearSiteSigningSecret, request),
  reindexCoreBlocks: (request = {}) =>
    invokeIpc(ipcChannels.settingsReindexCoreBlocks, request),
  getCompatibilityInfo: () => invokeIpc(ipcChannels.getCompatibilityInfo, {}),
  buildSiteExportBundle: (request) =>
    invokeIpc(ipcChannels.exportBuildSiteBundle, request),
  applySiteImportBundle: (request) =>
    invokeIpc(ipcChannels.importApplySiteBundle, request)
};

contextBridge.exposeInMainWorld("sitePilotDesktop", desktopApi);
