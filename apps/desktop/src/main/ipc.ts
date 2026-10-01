import { app, dialog, ipcMain } from "electron";

import { ipcChannels, ipcContracts } from "@sitepilot/contracts";
import { registerSharedIpcHandlers } from "@sitepilot/core/ipc-handlers";

import {
  getMcpServerState,
  regenerateMcpServerToken,
  saveMcpServerSettings
} from "./mcp-server-service.js";

export function registerIpcHandlers(): void {
  registerSharedIpcHandlers({
    handle: (channel, handler) =>
      ipcMain.handle(channel, (_event, payload) => handler(payload)),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "unknown",
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose WordPress core folder"
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  });

  // The local MCP server runs inside the desktop app only.
  ipcMain.handle(ipcChannels.mcpServerGetState, async (_event, payload) => {
    ipcContracts[ipcChannels.mcpServerGetState].request.parse(payload);
    return ipcContracts[ipcChannels.mcpServerGetState].response.parse({
      ok: true,
      state: await getMcpServerState()
    });
  });

  ipcMain.handle(ipcChannels.mcpServerSaveSettings, async (_event, payload) => {
    const req = ipcContracts[ipcChannels.mcpServerSaveSettings].request.parse(payload);
    return ipcContracts[ipcChannels.mcpServerSaveSettings].response.parse({
      ok: true,
      state: await saveMcpServerSettings({
        enabled: req.enabled,
        port: req.port,
        siteScope: req.siteScope === "all" ? "all" : [...req.siteScope]
      })
    });
  });

  ipcMain.handle(
    ipcChannels.mcpServerRegenerateToken,
    async (_event, payload) => {
      ipcContracts[ipcChannels.mcpServerRegenerateToken].request.parse(payload);
      return ipcContracts[ipcChannels.mcpServerRegenerateToken].response.parse({
        ok: true,
        state: await regenerateMcpServerToken()
      });
    }
  );
}
