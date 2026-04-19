import { z } from "zod";

import { workspaceListResponseSchema } from "./schemas.js";

export const ipcChannels = {
  getShellInfo: "app.getShellInfo",
  listWorkspaces: "workspace.list",
  listSites: "site.list",
  getProviderStatus: "settings.getProviderStatus"
} as const;

export const shellInfoResponseSchema = z.object({
  appName: z.string().min(1),
  appVersion: z.string().min(1),
  rendererVersion: z.string().min(1)
});

export const listWorkspacesRequestSchema = z.object({});

export const listSitesRequestSchema = z.object({
  workspaceId: z.string().min(1).optional()
});

export const siteSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  environment: z.enum(["production", "staging", "development"]),
  activationStatus: z.enum(["inactive", "config_required", "active"])
});

export const siteListResponseSchema = z.object({
  sites: z.array(siteSummarySchema)
});

export const providerStatusResponseSchema = z.object({
  configuredProviders: z.array(
    z.object({
      provider: z.enum(["openai", "anthropic", "compatible"]),
      label: z.string().min(1),
      isDefault: z.boolean()
    })
  )
});

export const ipcContracts = {
  [ipcChannels.getShellInfo]: {
    request: z.object({}),
    response: shellInfoResponseSchema
  },
  [ipcChannels.listWorkspaces]: {
    request: listWorkspacesRequestSchema,
    response: workspaceListResponseSchema
  },
  [ipcChannels.listSites]: {
    request: listSitesRequestSchema,
    response: siteListResponseSchema
  },
  [ipcChannels.getProviderStatus]: {
    request: z.object({}),
    response: providerStatusResponseSchema
  }
} as const;

export type IpcChannel = keyof typeof ipcContracts;
export type IpcRequest<TChannel extends IpcChannel> = z.infer<
  (typeof ipcContracts)[TChannel]["request"]
>;
export type IpcResponse<TChannel extends IpcChannel> = z.infer<
  (typeof ipcContracts)[TChannel]["response"]
>;

export type ShellInfoResponse = z.infer<typeof shellInfoResponseSchema>;
export type SiteListResponse = z.infer<typeof siteListResponseSchema>;
export type ProviderStatusResponse = z.infer<
  typeof providerStatusResponseSchema
>;

export interface SitePilotDesktopApi {
  getShellInfo: () => Promise<ShellInfoResponse>;
  listWorkspaces: () => Promise<IpcResponse<typeof ipcChannels.listWorkspaces>>;
  listSites: (
    request?: IpcRequest<typeof ipcChannels.listSites>
  ) => Promise<SiteListResponse>;
  getProviderStatus: () => Promise<ProviderStatusResponse>;
}
