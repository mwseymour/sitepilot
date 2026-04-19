import { z } from "zod";

import {
  actionRiskLevelSchema,
  actorSchema,
  auditEventTypeSchema,
  idSchema,
  isoTimestampSchema,
  jsonValueSchema,
  localizedTextBlockSchema,
  requestStatusSchema,
  siteActivationStatusSchema,
  siteConnectionStatusSchema,
  siteEnvironmentSchema,
  systemActorSchema,
  threadTypeSchema,
  timestampsSchema,
  toolInvocationStatusSchema,
  urlSchema
} from "./common.js";

const siteConfigSectionsSchema = z.object({
  identity: z.object({
    siteName: z.string().min(1),
    baseUrl: urlSchema,
    businessDescription: z.string().min(1),
    audienceSummary: z.string().min(1)
  }),
  structure: z.object({
    publicSections: z.array(z.string().min(1)),
    restrictedTemplates: z.array(z.string().min(1)),
    pageTreeSummary: z.string().min(1)
  }),
  contentModel: z.object({
    editablePostTypes: z.array(z.string().min(1)),
    readOnlyPostTypes: z.array(z.string().min(1)),
    taxonomyDefinitions: z.array(z.string().min(1))
  }),
  seoPolicy: z.object({
    titlePatterns: z.array(z.string().min(1)),
    redirectsRequireApproval: z.boolean(),
    internalLinkingExpectation: z.string().min(1)
  }),
  mediaPolicy: z.object({
    acceptedFormats: z.array(z.string().min(1)),
    altTextRequired: z.boolean(),
    featuredImageRequiredPostTypes: z.array(z.string().min(1))
  }),
  approvalPolicy: z.object({
    autoApproveCategories: z.array(z.string().min(1)),
    publishRequiresApproval: z.boolean(),
    menuChangesRequireApproval: z.boolean()
  }),
  toolAccessPolicy: z.object({
    enabledTools: z.array(z.string().min(1)),
    disabledTools: z.array(z.string().min(1)),
    dryRunOnlyTools: z.array(z.string().min(1))
  }),
  contentStylePolicy: z.object({
    tone: z.string().min(1),
    readingLevel: z.string().min(1),
    disallowedWording: z.array(z.string().min(1))
  }),
  guardrails: z.object({
    neverEditPages: z.array(z.string().min(1)),
    neverModifyMenuAutomatically: z.boolean(),
    neverPublishWithoutApproval: z.boolean()
  })
});

export const siteConfigSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  version: z.number().int().nonnegative(),
  requiredSectionsComplete: z.boolean(),
  activationStatus: siteActivationStatusSchema,
  sections: siteConfigSectionsSchema,
  metadata: z.object({
    generatedFromDiscoverySnapshotId: idSchema.optional(),
    confirmedByUserProfileId: idSchema.optional(),
    notes: z.array(z.string())
  }),
  ...timestampsSchema.shape
});

export const actionSchema = z.object({
  id: idSchema,
  type: z.string().min(1),
  version: z.number().int().positive(),
  input: z.record(jsonValueSchema),
  targetEntityRefs: z.array(z.string().min(1)),
  permissionRequirement: z.string().min(1),
  riskLevel: actionRiskLevelSchema,
  dryRunCapable: z.boolean(),
  rollbackSupported: z.boolean()
});

export const actionPlanSchema = z.object({
  id: idSchema,
  requestId: idSchema,
  siteId: idSchema,
  requestSummary: z.string().min(1),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  targetEntities: z.array(z.string().min(1)),
  proposedActions: z.array(actionSchema).min(1),
  dependencies: z.array(z.string().min(1)),
  approvalRequired: z.boolean(),
  riskLevel: actionRiskLevelSchema,
  rollbackNotes: z.array(z.string()),
  validationWarnings: z.array(z.string()),
  ...timestampsSchema.shape
});

export const auditEntrySchema = z.object({
  id: idSchema,
  siteId: idSchema,
  requestId: idSchema.optional(),
  actionId: idSchema.optional(),
  executionRunId: idSchema.optional(),
  eventType: auditEventTypeSchema,
  actor: z.union([actorSchema, systemActorSchema]),
  metadata: z.record(jsonValueSchema),
  promptVersion: z.string().optional(),
  model: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1)
    })
    .optional(),
  ...timestampsSchema.shape
});

export const discoverySnapshotSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  revision: z.number().int().nonnegative(),
  environment: siteEnvironmentSchema,
  siteMetadata: z.record(jsonValueSchema),
  contentModel: z.record(jsonValueSchema),
  taxonomyModel: z.record(jsonValueSchema),
  pageHierarchy: z.array(z.string()),
  fieldSchema: z.record(jsonValueSchema),
  menuSchema: z.record(jsonValueSchema),
  capabilitySummary: z.array(z.string()),
  warnings: z.array(z.string()),
  knownLimitations: z.array(z.string()),
  ...timestampsSchema.shape
});

export const approvalPayloadSchema = z.object({
  approvalRequestId: idSchema,
  siteId: idSchema,
  requestId: idSchema,
  threadId: idSchema,
  requestSummary: z.string().min(1),
  proposedActions: z.array(actionSchema).min(1),
  objectDiffs: z.array(
    z.object({
      objectType: z.string().min(1),
      objectId: z.string().min(1),
      changes: z.array(
        z.object({
          field: z.string().min(1),
          before: jsonValueSchema.optional(),
          after: jsonValueSchema.optional()
        })
      )
    })
  ),
  contentPreview: localizedTextBlockSchema.optional(),
  affectedUrls: z.array(urlSchema),
  riskLevel: actionRiskLevelSchema,
  rollbackNotes: z.array(z.string()),
  reasoningSummary: z.string().min(1),
  executionDependencies: z.array(z.string())
});

export const workspaceSummarySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  slug: z.string().min(1)
});

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema)
});

export const chatThreadSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  title: z.string().min(1),
  type: threadTypeSchema,
  archivedAt: isoTimestampSchema.optional(),
  ...timestampsSchema.shape
});

export const chatMessageSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  siteId: idSchema,
  author: z.union([actorSchema, systemActorSchema]),
  body: localizedTextBlockSchema,
  requestId: idSchema.optional(),
  ...timestampsSchema.shape
});

export const requestSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  threadId: idSchema,
  requestedBy: actorSchema,
  status: requestStatusSchema,
  userPrompt: z.string().min(1),
  latestPlanId: idSchema.optional(),
  latestExecutionRunId: idSchema.optional(),
  ...timestampsSchema.shape
});

export const toolInvocationSchema = z.object({
  id: idSchema,
  executionRunId: idSchema,
  actionId: idSchema.optional(),
  toolName: z.string().min(1),
  status: toolInvocationStatusSchema,
  input: z.record(jsonValueSchema),
  output: z.record(jsonValueSchema).optional(),
  errorCode: z.string().optional(),
  ...timestampsSchema.shape
});

export const siteConnectionSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  status: siteConnectionStatusSchema,
  protocolVersion: z.string().min(1),
  pluginVersion: z.string().min(1),
  clientIdentifier: z.string().min(1),
  trustedAppOrigin: urlSchema,
  credentialFingerprint: z.string().optional(),
  rotatedAt: isoTimestampSchema.optional(),
  revokedAt: isoTimestampSchema.optional(),
  ...timestampsSchema.shape
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type Action = z.infer<typeof actionSchema>;
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type DiscoverySnapshot = z.infer<typeof discoverySnapshotSchema>;
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
