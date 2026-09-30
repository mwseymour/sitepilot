import { z } from "zod";

import {
  actionRiskLevelSchema,
  actorSchema,
  auditEventTypeSchema,
  idSchema,
  imageAttachmentSchema,
  isoTimestampSchema,
  jsonValueSchema,
  localizedTextBlockSchema,
  requestStatusSchema,
  siteActivationStatusSchema,
  siteConnectionStatusSchema,
  siteEnvironmentSchema,
  systemActorSchema,
  threadTypeSchema,
  clientSourceSchema,
  timestampsSchema,
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
    taxonomyDefinitions: z.array(z.string().min(1)),
    thirdPartyBlocks: z.array(z.string().min(1)).default([]),
    customBlockSupport: z
      .array(
        z.object({
          name: z.string().min(1),
          support: z.enum(["passthrough", "manual_review_required"]),
          reason: z.string().min(1),
          schemaNotes: z.string().min(1).optional(),
          attributes: z
            .array(
              z.object({
                path: z.string().min(1),
                fieldName: z.string().min(1).optional(),
                fieldKey: z.string().min(1).optional(),
                label: z.string().min(1).optional(),
                control: z.string().min(1).optional(),
                options: z
                  .array(
                    z.object({
                      label: z.string().min(1),
                      value: z.string().min(1)
                    })
                  )
                  .optional()
              })
            )
            .optional()
        })
      )
      .default([])
  }),
  seoPolicy: z.object({
    titlePatterns: z.array(z.string().min(1)),
    metaProvider: z.enum(["sitepilot", "yoast"]).default("sitepilot"),
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

export const uiPreferencesSchema = z.object({
  developerToolsEnabled: z.boolean(),
  preserveOriginalImageUploads: z.boolean()
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

export type ParsedBlock = {
  blockName: string;
  attrs: Record<string, unknown>;
  innerBlocks: ParsedBlock[];
  innerHTML: string;
  innerContent: Array<string | null>;
};

export const parsedBlockSchema: z.ZodType<ParsedBlock> = z.lazy(() =>
  z.object({
    blockName: z.string().min(1),
    attrs: z.record(jsonValueSchema),
    innerBlocks: z.array(parsedBlockSchema),
    innerHTML: z.string(),
    innerContent: z.array(z.string().nullable())
  })
);

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
  source: clientSourceSchema.optional(),
  ...timestampsSchema.shape
});

export const chatMessageSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  siteId: idSchema,
  author: z.union([actorSchema, systemActorSchema]),
  body: localizedTextBlockSchema,
  attachments: z.array(imageAttachmentSchema).optional(),
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
  attachments: z.array(imageAttachmentSchema).optional(),
  latestPlanId: idSchema.optional(),
  latestExecutionRunId: idSchema.optional(),
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

export const clarificationRoundSchema = z.object({
  id: idSchema,
  requestId: idSchema,
  siteId: idSchema,
  questions: z.array(z.string()),
  answers: z.array(z.string()),
  resolvedAt: isoTimestampSchema.optional(),
  ...timestampsSchema.shape
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type ChatThreadPayload = z.infer<typeof chatThreadSchema>;
export type ChatMessagePayload = z.infer<typeof chatMessageSchema>;
export type Action = z.infer<typeof actionSchema>;
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type DiscoverySnapshot = z.infer<typeof discoverySnapshotSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
export type ClarificationRoundPayload = z.infer<
  typeof clarificationRoundSchema
>;
export type UiPreferences = z.infer<typeof uiPreferencesSchema>;
