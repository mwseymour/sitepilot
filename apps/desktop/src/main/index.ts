import { app, BrowserWindow, screen, shell } from "electron";
import { registerIpcHandlers } from "./ipc.js";
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
