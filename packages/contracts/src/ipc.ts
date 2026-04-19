import { z } from "zod";

import { siteEnvironmentSchema, urlSchema } from "./common.js";
import { siteRegistrationSchema } from "./protocol.js";
import { workspaceListResponseSchema } from "./schemas.js";

export const ipcChannels = {
  getShellInfo: "app.getShellInfo",
  listWorkspaces: "workspace.list",
  listSites: "site.list",
  registerSite: "site.register",
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

export const registerSiteRequestSchema = z.object({
  baseUrl: z.string().url(),
  registrationCode: z.string().min(1),
  siteName: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  environment: siteEnvironmentSchema.optional(),
  trustedAppOrigin: urlSchema.optional()
});

export const registerSiteSuccessResponseSchema = z.object({
  ok: z.literal(true),
  site: siteSummarySchema,
  registration: siteRegistrationSchema,
  mcpToolCount: z.number().int().nonnegative()
});

export const registerSiteErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string().min(1),
  message: z.string().min(1)
});

export const registerSiteResponseSchema = z.discriminatedUnion("ok", [
  registerSiteSuccessResponseSchema,
  registerSiteErrorResponseSchema
]);

export type RegisterSiteResponse = z.infer<typeof registerSiteResponseSchema>;

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
  [ipcChannels.registerSite]: {
    request: registerSiteRequestSchema,
    response: registerSiteResponseSchema
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
  registerSite: (
    request: IpcRequest<typeof ipcChannels.registerSite>
  ) => Promise<IpcResponse<typeof ipcChannels.registerSite>>;
  getProviderStatus: () => Promise<ProviderStatusResponse>;
}
