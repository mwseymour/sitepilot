import { app, BrowserWindow } from "electron";
import { registerIpcHandlers } from "./ipc.js";
import {
  createMainWindowOptions,
  resolveRendererEntry
} from "./window-config.js";

export async function createMainWindow(): Promise<BrowserWindow> {
  const mainWindow = new BrowserWindow(createMainWindowOptions());

  await mainWindow.loadFile(resolveRendererEntry());

  return mainWindow;
}

function registerLifecycle(): void {
  registerIpcHandlers();

  void app.whenReady().then(async () => {
    await createMainWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

registerLifecycle();
