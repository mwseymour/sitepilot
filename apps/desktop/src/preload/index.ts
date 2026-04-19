import { contextBridge } from "electron";

export interface SitePilotShellInfo {
  appName: string;
  rendererVersion: string;
}

export interface SitePilotDesktopApi {
  getShellInfo: () => SitePilotShellInfo;
}

const desktopApi: SitePilotDesktopApi = {
  getShellInfo: () => ({
    appName: "SitePilot",
    rendererVersion: "0.1.0"
  })
};

contextBridge.exposeInMainWorld("sitePilotDesktop", desktopApi);
