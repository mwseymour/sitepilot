import { contextBridge, ipcRenderer } from "electron";

import { createSitePilotDesktopApi } from "@sitepilot/contracts";

contextBridge.exposeInMainWorld(
  "sitePilotDesktop",
  createSitePilotDesktopApi((channel, request) =>
    ipcRenderer.invoke(channel, request)
  )
);
