import type { SitePilotDesktopApi } from "@sitepilot/contracts";

declare global {
  interface Window {
    sitePilotDesktop: SitePilotDesktopApi;
    /** Set in the hosted app; see hosted.ts. */
    sitePilotHosted?: boolean;
  }
}

export {};
