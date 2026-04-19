import { describe, expect, it } from "vitest";

import {
  ipcChannels,
  ipcContracts,
  shellInfoResponseSchema,
  type IpcResponse,
  type SitePilotDesktopApi
} from "@sitepilot/contracts";

describe("ipc contracts", () => {
  it("defines typed channels with request and response schemas", () => {
    const request = ipcContracts[ipcChannels.listSites].request.parse({
      workspaceId: "workspace-1"
    });
    const response: IpcResponse<typeof ipcChannels.listSites> = ipcContracts[
      ipcChannels.listSites
    ].response.parse({
      sites: [
        {
          id: "site-1",
          workspaceId: request.workspaceId,
          name: "Example Site",
          baseUrl: "https://example.com",
          environment: "production",
          activationStatus: "active"
        }
      ]
    });

    expect(response.sites[0]?.name).toBe("Example Site");
  });

  it("matches the preload bridge API shape", async () => {
    const api: SitePilotDesktopApi = {
      getShellInfo: async () =>
        shellInfoResponseSchema.parse({
          appName: "SitePilot",
          appVersion: "0.1.0",
          rendererVersion: "0.1.0"
        }),
      listWorkspaces: async () => ({ workspaces: [] }),
      listSites: async () => ({ sites: [] }),
      getProviderStatus: async () => ({ configuredProviders: [] })
    };

    await expect(api.getShellInfo()).resolves.toMatchObject({
      appName: "SitePilot"
    });
  });
});
