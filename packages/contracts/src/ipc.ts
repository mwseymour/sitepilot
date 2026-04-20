import { z } from "zod";

import {
  actorSchema,
  approvalStateSchema,
  auditEventTypeSchema,
  idSchema,
  isoTimestampSchema,
  jsonValueSchema,
  siteEnvironmentSchema,
  systemActorSchema,
  threadTypeSchema,
  urlSchema
} from "./common.js";
import { siteRegistrationSchema } from "./protocol.js";
import {
  actionPlanSchema,
  chatMessageSchema,
  chatThreadSchema,
  clarificationRoundSchema,
  plannerContextSchema,
  requestSchema,
  siteConfigSchema,
  workspaceListResponseSchema
} from "./schemas.js";

export const ipcChannels = {
  getShellInfo: "app.getShellInfo",
  listWorkspaces: "workspace.list",
  listSites: "site.list",
  registerSite: "site.register",
  runSiteDiagnostics: "site.runDiagnostics",
  refreshSiteDiscovery: "site.refreshDiscovery",
  generateSiteConfigDraft: "site.generateConfigDraft",
  getSiteWorkspace: "site.getWorkspace",
  saveSiteConfig: "site.saveConfig",
  confirmSiteConfig: "site.confirmConfig",
  listChatThreads: "chat.listThreads",
  createChatThread: "chat.createThread",
  listChatMessages: "chat.listMessages",
  postChatMessage: "chat.postMessage",
  createChatRequest: "chat.createRequest",
  buildPlannerContext: "planner.buildContext",
  generateActionPlan: "planner.generateActionPlan",
  listPendingApprovals: "approvals.listPending",
  decideApproval: "approvals.decide",
  listAuditEntries: "audit.listEntries",
  getRequestBundle: "chat.getRequestBundle",
  executePlanAction: "execution.executePlanAction",
  getProviderStatus: "settings.getProviderStatus",
  settingsGetState: "settings.getState",
  settingsSetProviderSecret: "settings.setProviderSecret",
  settingsClearProviderSecret: "settings.clearProviderSecret",
  settingsSetPlannerPreferences: "settings.setPlannerPreferences",
  settingsClearSiteSigningSecret: "settings.clearSiteSigningSecret",
  getCompatibilityInfo: "app.getCompatibilityInfo",
  exportBuildSiteBundle: "export.buildSiteBundle",
  importApplySiteBundle: "import.applySiteBundle"
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

export type SiteSummary = z.infer<typeof siteSummarySchema>;

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

export const generateSiteConfigDraftResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({
      ok: z.literal(true),
      siteConfig: siteConfigSchema
    }),
    z.object({
      ok: z.literal(false),
      code: z.string().min(1),
      message: z.string().min(1)
    })
  ]
);

export type GenerateSiteConfigDraftResponse = z.infer<
  typeof generateSiteConfigDraftResponseSchema
>;

export const siteWorkspaceStateSchema = z.object({
  site: siteSummarySchema,
  siteConfig: siteConfigSchema.nullable(),
  discoveryRevision: z.number().int().nonnegative().nullable()
});

export const getSiteWorkspaceResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).merge(siteWorkspaceStateSchema),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type GetSiteWorkspaceResponse = z.infer<
  typeof getSiteWorkspaceResponseSchema
>;

export const saveSiteConfigRequestSchema = z.object({
  siteId: idSchema,
  siteConfig: siteConfigSchema
});

export const saveSiteConfigResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    siteConfig: siteConfigSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type SaveSiteConfigResponse = z.infer<
  typeof saveSiteConfigResponseSchema
>;

export const confirmSiteConfigRequestSchema = z.object({
  siteId: idSchema,
  configId: idSchema
});

export const confirmSiteConfigResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    site: siteSummarySchema,
    siteConfig: siteConfigSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type ConfirmSiteConfigResponse = z.infer<
  typeof confirmSiteConfigResponseSchema
>;

export const listChatThreadsResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    threads: z.array(chatThreadSchema)
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const createChatThreadRequestSchema = z.object({
  siteId: idSchema,
  title: z.string().min(1),
  type: threadTypeSchema.optional()
});

export const createChatThreadResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    thread: chatThreadSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const siteThreadRequestSchema = z.object({
  siteId: idSchema,
  threadId: idSchema
});

export const listChatMessagesResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    messages: z.array(chatMessageSchema)
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const postChatMessageRequestSchema = z.object({
  siteId: idSchema,
  threadId: idSchema,
  text: z.string().min(1)
});

export const postChatMessageResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    message: chatMessageSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const createChatRequestRequestSchema = z.object({
  siteId: idSchema,
  threadId: idSchema,
  userPrompt: z.string().min(1)
});

export const createChatRequestResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    request: requestSchema,
    clarificationRound: clarificationRoundSchema.optional()
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const buildPlannerContextRequestSchema = siteThreadRequestSchema;

export const buildPlannerContextResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    context: plannerContextSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const planValidationOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pass") }),
  z.object({
    kind: z.literal("warnings"),
    messages: z.array(z.string())
  }),
  z.object({
    kind: z.literal("blocked_clarification"),
    messages: z.array(z.string())
  }),
  z.object({
    kind: z.literal("blocked_approval"),
    messages: z.array(z.string())
  }),
  z.object({
    kind: z.literal("blocked"),
    messages: z.array(z.string())
  })
]);

export const generateActionPlanRequestSchema = z.object({
  siteId: idSchema,
  threadId: idSchema,
  requestId: idSchema
});

export const generateActionPlanResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    plan: actionPlanSchema,
    validation: planValidationOutcomeSchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const approvalSummarySchema = z.object({
  id: idSchema,
  requestId: idSchema,
  planId: idSchema,
  siteId: idSchema,
  status: approvalStateSchema,
  expiresAt: isoTimestampSchema.optional()
});

export const listPendingApprovalsResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    approvals: z.array(approvalSummarySchema)
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const decideApprovalRequestSchema = z.object({
  siteId: idSchema,
  approvalRequestId: idSchema,
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  note: z.string().optional()
});

export const decideApprovalResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    approval: approvalSummarySchema
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const ipcAuditEntrySchema = z.object({
  id: idSchema,
  siteId: idSchema,
  requestId: idSchema.optional(),
  actionId: idSchema.optional(),
  eventType: auditEventTypeSchema,
  actor: z.union([actorSchema, systemActorSchema]),
  metadata: z.record(jsonValueSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const listAuditEntriesRequestSchema = z.object({
  siteId: idSchema,
  requestId: idSchema.optional(),
  actionId: idSchema.optional(),
  eventTypes: z.array(auditEventTypeSchema).max(50).optional(),
  since: isoTimestampSchema.optional(),
  until: isoTimestampSchema.optional(),
  executionOutcome: z.enum(["any", "failed", "succeeded"]).optional(),
  rollbackRelatedOnly: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional()
});

export const listAuditEntriesResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    entries: z.array(ipcAuditEntrySchema)
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;
export type AuditLogEntry = z.infer<typeof ipcAuditEntrySchema>;

export const plannerPreferencesSchema = z.object({
  preferredProvider: z.enum(["auto", "openai", "anthropic"]),
  openaiModel: z.string().min(1).max(120),
  anthropicModel: z.string().min(1).max(120)
});

export type PlannerPreferencesPayload = z.infer<
  typeof plannerPreferencesSchema
>;

export const settingsGetStateRequestSchema = z.object({
  workspaceId: idSchema.optional(),
  siteId: idSchema.optional()
});

export const settingsGetStateResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    configuredProviders: providerStatusResponseSchema.shape.configuredProviders,
    planner: plannerPreferencesSchema,
    siteHasSigningSecret: z.boolean().optional()
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const settingsSetProviderSecretRequestSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  secret: z.string().min(1).max(8192)
});

export const settingsOkOnlyResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const settingsSetPlannerPreferencesRequestSchema = z.object({
  workspaceId: idSchema.optional(),
  preferences: plannerPreferencesSchema
});

export const settingsClearSiteSigningSecretRequestSchema = z.object({
  siteId: idSchema
});

export const compatibilityInfoResponseSchema = z.object({
  appVersion: z.string().min(1),
  electronVersion: z.string().min(1),
  sitepilotProtocolVersion: z.string().min(1),
  minPluginProtocolVersion: z.string().min(1)
});

export const exportBuildSiteBundleRequestSchema = z.object({
  siteId: idSchema
});

export const exportBuildSiteBundleResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    bundleJson: z.string().min(1)
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const importApplySiteBundleRequestSchema = z.object({
  bundleJson: z.string().min(1)
});

export const importApplySiteBundleResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    siteId: idSchema,
    auditsImported: z.number().int().nonnegative(),
    configsImported: z.number().int().nonnegative()
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const getRequestBundleRequestSchema = z.object({
  siteId: idSchema,
  threadId: idSchema,
  requestId: idSchema
});

export const requestBundleLastExecutionSchema = z.object({
  id: idSchema,
  status: z.string().min(1),
  idempotencyKey: z.string().min(1),
  completedAt: isoTimestampSchema.optional()
});

export const getRequestBundleResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    request: requestSchema,
    plan: actionPlanSchema.nullable(),
    pendingApproval: approvalSummarySchema.nullable(),
    lastExecution: requestBundleLastExecutionSchema.nullable()
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const executePlanActionRequestSchema = z.object({
  siteId: idSchema,
  requestId: idSchema,
  planId: idSchema,
  actionId: idSchema,
  dryRun: z.boolean(),
  idempotencyKey: z.string().min(1).optional()
});

export const executePlanActionResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    dryRun: z.boolean(),
    mcpResult: z.record(jsonValueSchema),
    skipped: z.boolean().optional(),
    reused: z.boolean().optional(),
    toolName: z.string().optional(),
    executionRunId: idSchema.optional(),
    toolInvocationId: idSchema.optional()
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

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
  [ipcChannels.generateSiteConfigDraft]: {
    request: siteIdRequestSchema,
    response: generateSiteConfigDraftResponseSchema
  },
  [ipcChannels.getSiteWorkspace]: {
    request: siteIdRequestSchema,
    response: getSiteWorkspaceResponseSchema
  },
  [ipcChannels.saveSiteConfig]: {
    request: saveSiteConfigRequestSchema,
    response: saveSiteConfigResponseSchema
  },
  [ipcChannels.confirmSiteConfig]: {
    request: confirmSiteConfigRequestSchema,
    response: confirmSiteConfigResponseSchema
  },
  [ipcChannels.listChatThreads]: {
    request: siteIdRequestSchema,
    response: listChatThreadsResponseSchema
  },
  [ipcChannels.createChatThread]: {
    request: createChatThreadRequestSchema,
    response: createChatThreadResponseSchema
  },
  [ipcChannels.listChatMessages]: {
    request: siteThreadRequestSchema,
    response: listChatMessagesResponseSchema
  },
  [ipcChannels.postChatMessage]: {
    request: postChatMessageRequestSchema,
    response: postChatMessageResponseSchema
  },
  [ipcChannels.createChatRequest]: {
    request: createChatRequestRequestSchema,
    response: createChatRequestResponseSchema
  },
  [ipcChannels.buildPlannerContext]: {
    request: buildPlannerContextRequestSchema,
    response: buildPlannerContextResponseSchema
  },
  [ipcChannels.generateActionPlan]: {
    request: generateActionPlanRequestSchema,
    response: generateActionPlanResponseSchema
  },
  [ipcChannels.listPendingApprovals]: {
    request: siteIdRequestSchema,
    response: listPendingApprovalsResponseSchema
  },
  [ipcChannels.decideApproval]: {
    request: decideApprovalRequestSchema,
    response: decideApprovalResponseSchema
  },
  [ipcChannels.listAuditEntries]: {
    request: listAuditEntriesRequestSchema,
    response: listAuditEntriesResponseSchema
  },
  [ipcChannels.getRequestBundle]: {
    request: getRequestBundleRequestSchema,
    response: getRequestBundleResponseSchema
  },
  [ipcChannels.executePlanAction]: {
    request: executePlanActionRequestSchema,
    response: executePlanActionResponseSchema
  },
  [ipcChannels.getProviderStatus]: {
    request: z.object({}),
    response: providerStatusResponseSchema
  },
  [ipcChannels.settingsGetState]: {
    request: settingsGetStateRequestSchema,
    response: settingsGetStateResponseSchema
  },
  [ipcChannels.settingsSetProviderSecret]: {
    request: settingsSetProviderSecretRequestSchema,
    response: settingsOkOnlyResponseSchema
  },
  [ipcChannels.settingsClearProviderSecret]: {
    request: z.object({ provider: z.enum(["openai", "anthropic"]) }),
    response: settingsOkOnlyResponseSchema
  },
  [ipcChannels.settingsSetPlannerPreferences]: {
    request: settingsSetPlannerPreferencesRequestSchema,
    response: settingsOkOnlyResponseSchema
  },
  [ipcChannels.settingsClearSiteSigningSecret]: {
    request: settingsClearSiteSigningSecretRequestSchema,
    response: settingsOkOnlyResponseSchema
  },
  [ipcChannels.getCompatibilityInfo]: {
    request: z.object({}),
    response: compatibilityInfoResponseSchema
  },
  [ipcChannels.exportBuildSiteBundle]: {
    request: exportBuildSiteBundleRequestSchema,
    response: exportBuildSiteBundleResponseSchema
  },
  [ipcChannels.importApplySiteBundle]: {
    request: importApplySiteBundleRequestSchema,
    response: importApplySiteBundleResponseSchema
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
  generateSiteConfigDraft: (
    request: IpcRequest<typeof ipcChannels.generateSiteConfigDraft>
  ) => Promise<IpcResponse<typeof ipcChannels.generateSiteConfigDraft>>;
  getSiteWorkspace: (
    request: IpcRequest<typeof ipcChannels.getSiteWorkspace>
  ) => Promise<IpcResponse<typeof ipcChannels.getSiteWorkspace>>;
  saveSiteConfig: (
    request: IpcRequest<typeof ipcChannels.saveSiteConfig>
  ) => Promise<IpcResponse<typeof ipcChannels.saveSiteConfig>>;
  confirmSiteConfig: (
    request: IpcRequest<typeof ipcChannels.confirmSiteConfig>
  ) => Promise<IpcResponse<typeof ipcChannels.confirmSiteConfig>>;
  listChatThreads: (
    request: IpcRequest<typeof ipcChannels.listChatThreads>
  ) => Promise<IpcResponse<typeof ipcChannels.listChatThreads>>;
  createChatThread: (
    request: IpcRequest<typeof ipcChannels.createChatThread>
  ) => Promise<IpcResponse<typeof ipcChannels.createChatThread>>;
  listChatMessages: (
    request: IpcRequest<typeof ipcChannels.listChatMessages>
  ) => Promise<IpcResponse<typeof ipcChannels.listChatMessages>>;
  postChatMessage: (
    request: IpcRequest<typeof ipcChannels.postChatMessage>
  ) => Promise<IpcResponse<typeof ipcChannels.postChatMessage>>;
  createChatRequest: (
    request: IpcRequest<typeof ipcChannels.createChatRequest>
  ) => Promise<IpcResponse<typeof ipcChannels.createChatRequest>>;
  buildPlannerContext: (
    request: IpcRequest<typeof ipcChannels.buildPlannerContext>
  ) => Promise<IpcResponse<typeof ipcChannels.buildPlannerContext>>;
  generateActionPlan: (
    request: IpcRequest<typeof ipcChannels.generateActionPlan>
  ) => Promise<IpcResponse<typeof ipcChannels.generateActionPlan>>;
  listPendingApprovals: (
    request: IpcRequest<typeof ipcChannels.listPendingApprovals>
  ) => Promise<IpcResponse<typeof ipcChannels.listPendingApprovals>>;
  decideApproval: (
    request: IpcRequest<typeof ipcChannels.decideApproval>
  ) => Promise<IpcResponse<typeof ipcChannels.decideApproval>>;
  listAuditEntries: (
    request: IpcRequest<typeof ipcChannels.listAuditEntries>
  ) => Promise<IpcResponse<typeof ipcChannels.listAuditEntries>>;
  getRequestBundle: (
    request: IpcRequest<typeof ipcChannels.getRequestBundle>
  ) => Promise<IpcResponse<typeof ipcChannels.getRequestBundle>>;
  executePlanAction: (
    request: IpcRequest<typeof ipcChannels.executePlanAction>
  ) => Promise<IpcResponse<typeof ipcChannels.executePlanAction>>;
  getProviderStatus: () => Promise<ProviderStatusResponse>;
  getSettingsState: (
    request: IpcRequest<typeof ipcChannels.settingsGetState>
  ) => Promise<IpcResponse<typeof ipcChannels.settingsGetState>>;
  setProviderSecret: (
    request: IpcRequest<typeof ipcChannels.settingsSetProviderSecret>
  ) => Promise<IpcResponse<typeof ipcChannels.settingsSetProviderSecret>>;
  clearProviderSecret: (
    request: IpcRequest<typeof ipcChannels.settingsClearProviderSecret>
  ) => Promise<IpcResponse<typeof ipcChannels.settingsClearProviderSecret>>;
  setPlannerPreferences: (
    request: IpcRequest<typeof ipcChannels.settingsSetPlannerPreferences>
  ) => Promise<IpcResponse<typeof ipcChannels.settingsSetPlannerPreferences>>;
  clearSiteSigningSecret: (
    request: IpcRequest<typeof ipcChannels.settingsClearSiteSigningSecret>
  ) => Promise<IpcResponse<typeof ipcChannels.settingsClearSiteSigningSecret>>;
  getCompatibilityInfo: () => Promise<
    IpcResponse<typeof ipcChannels.getCompatibilityInfo>
  >;
  buildSiteExportBundle: (
    request: IpcRequest<typeof ipcChannels.exportBuildSiteBundle>
  ) => Promise<IpcResponse<typeof ipcChannels.exportBuildSiteBundle>>;
  applySiteImportBundle: (
    request: IpcRequest<typeof ipcChannels.importApplySiteBundle>
  ) => Promise<IpcResponse<typeof ipcChannels.importApplySiteBundle>>;
}
