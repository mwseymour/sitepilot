import { z } from "zod";

import {
  idSchema,
  isoTimestampSchema,
  jsonValueSchema,
  siteEnvironmentSchema,
  urlSchema
} from "./common.js";
import { siteRegistrationSchema } from "./protocol.js";
import { workspaceListResponseSchema } from "./schemas.js";

export const ipcChannels = {
  getShellInfo: "app.getShellInfo",
  listWorkspaces: "workspace.list",
  listSites: "site.list",
  registerSite: "site.register",
  runSiteDiagnostics: "site.runDiagnostics",
  refreshSiteDiscovery: "site.refreshDiscovery",
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

export const siteIdRequestSchema = z.object({
  siteId: idSchema
});

export const connectivityDiagnosticsSchema = z.object({
  siteId: idSchema,
  checkedAt: isoTimestampSchema,
  overallOk: z.boolean(),
  checks: z.object({
    health: z.object({
      ok: z.boolean(),
      httpStatus: z.number().int().optional(),
      latencyMs: z.number().int().optional(),
      message: z.string().optional()
    }),
    protocolMetadata: z.object({
      ok: z.boolean(),
      protocolVersion: z.string().optional(),
      pluginVersion: z.string().optional(),
      compatibilityOk: z.boolean().optional(),
      compatibilityReason: z.string().optional(),
      latencyMs: z.number().int().optional(),
      message: z.string().optional()
    }),
    authentication: z.object({
      ok: z.boolean(),
      message: z.string().optional()
    }),
    mcpTools: z.object({
      ok: z.boolean(),
      toolNames: z.array(z.string()),
      message: z.string().optional()
    }),
    pluginVersion: z.object({
      ok: z.boolean(),
      version: z.string().optional(),
      message: z.string().optional()
    })
  })
});

export const persistedDiscoverySnapshotSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  revision: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  capabilities: z.array(z.string()),
  summary: z.record(jsonValueSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const refreshDiscoveryResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    snapshot: persistedDiscoverySnapshotSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type RefreshDiscoveryResponse = z.infer<
  typeof refreshDiscoveryResponseSchema
>;

export type ConnectivityDiagnosticsResult = z.infer<
  typeof connectivityDiagnosticsSchema
>;

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
  [ipcChannels.runSiteDiagnostics]: {
    request: siteIdRequestSchema,
    response: connectivityDiagnosticsSchema
  },
  [ipcChannels.refreshSiteDiscovery]: {
    request: siteIdRequestSchema,
    response: refreshDiscoveryResponseSchema
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
  runSiteDiagnostics: (
    request: IpcRequest<typeof ipcChannels.runSiteDiagnostics>
  ) => Promise<IpcResponse<typeof ipcChannels.runSiteDiagnostics>>;
  refreshSiteDiscovery: (
    request: IpcRequest<typeof ipcChannels.refreshSiteDiscovery>
  ) => Promise<IpcResponse<typeof ipcChannels.refreshSiteDiscovery>>;
  getProviderStatus: () => Promise<ProviderStatusResponse>;
}
