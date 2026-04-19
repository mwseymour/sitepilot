import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MainWindowOptions {
  width: number;
  height: number;
  title: string;
  backgroundColor: string;
  webPreferences: {
    preload: string;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
  };
}

export function getPreloadPath(): string {
  return join(__dirname, "..", "preload", "index.js");
}

export function resolveRendererEntry(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

export function createMainWindowOptions(): MainWindowOptions {
  return {
    width: 1440,
    height: 960,
    title: "SitePilot",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}
