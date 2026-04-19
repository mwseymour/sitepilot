import type { SitePilotDesktopApi } from "../preload/index.js";

declare global {
  interface Window {
    sitePilotDesktop: SitePilotDesktopApi;
  }
}

export {};
