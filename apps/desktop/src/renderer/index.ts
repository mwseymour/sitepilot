import { preloadVersion } from "../preload/index.js";

export function renderAppShell(): string {
  return `sitepilot-renderer:${preloadVersion}`;
}
