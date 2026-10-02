import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MainWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  center: boolean;
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

/** The Dock icon for development runs; packaged builds use build/icon.icns. */
export function resolveDevDockIcon(): string {
  return join(__dirname, "..", "..", "build", "icon-macos.png");
}

export interface WorkAreaSize {
  width: number;
  height: number;
}

const MIN_WINDOW = { width: 1100, height: 720 };
const MAX_WINDOW = { width: 1920, height: 1200 };

/**
 * Opens the window at 95% of the screen's usable area, so it starts large on
 * laptops and big monitors alike, within sensible minimum and maximum sizes.
 */
export function resolveInitialWindowSize(
  workArea: WorkAreaSize = { width: 1600, height: 1040 }
): { width: number; height: number } {
  const fit = (available: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(Math.min(min, available), available * 0.95)));
  return {
    width: fit(workArea.width, MIN_WINDOW.width, MAX_WINDOW.width),
    height: fit(workArea.height, MIN_WINDOW.height, MAX_WINDOW.height)
  };
}

export function createMainWindowOptions(
  workArea?: WorkAreaSize
): MainWindowOptions {
  const size = resolveInitialWindowSize(workArea);
  return {
    ...size,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    center: true,
    title: "SitePilot",
    // Matches --surface-0 in the light theme so the window doesn't flash dark.
    backgroundColor: "#f4f2ee",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}
