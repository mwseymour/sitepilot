import type { SitePilotDesktopApi } from "@sitepilot/contracts";

declare global {
  interface Window {
    sitePilotDesktop: SitePilotDesktopApi;
  }
}

export {};
