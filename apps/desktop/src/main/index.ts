import { app, BrowserWindow, screen, shell } from "electron";

import { configureDesktopRuntime } from "./desktop-runtime.js";
import { registerIpcHandlers } from "./ipc.js";
import {
  startMcpServerIfEnabled,
  stopMcpServer
} from "./mcp-server-service.js";
import {
  createMainWindowOptions,
  resolveRendererEntry
} from "./window-config.js";

export async function createMainWindow(): Promise<BrowserWindow> {
  const mainWindow = new BrowserWindow(
    createMainWindowOptions(screen.getPrimaryDisplay().workAreaSize)
  );

  // Web links (such as a post's WordPress edit screen) open in the browser,
  // never inside the app window.
  const openInBrowser = (url: string): boolean => {
    if (!/^https?:\/\//i.test(url)) return false;
    void shell.openExternal(url);
    return true;
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (openInBrowser(url)) event.preventDefault();
  });

  await mainWindow.loadFile(resolveRendererEntry());

  return mainWindow;
}

function registerLifecycle(): void {
  configureDesktopRuntime();
  registerIpcHandlers();

  void app.whenReady().then(async () => {
    await createMainWindow();
    // A failed start is reported in Settings, not as a launch error.
    void startMcpServerIfEnabled(app.getVersion()).catch(() => undefined);

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });

  app.on("will-quit", () => {
    void stopMcpServer();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

registerLifecycle();
