import { z } from "zod";

import {
  actionRiskLevels,
  approvalStates,
  auditEventTypes,
  requestStatuses,
  siteActivationStatuses,
  siteConnectionStatuses,
  siteEnvironments,
  threadTypes,
  toolInvocationStatuses
} from "@sitepilot/domain";

export const isoTimestampSchema = z.string().datetime({ offset: true });
export const urlSchema = z.string().url();
export const idSchema = z.string().min(1);
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

export const actionRiskLevelSchema = z.enum(actionRiskLevels);
export const approvalStateSchema = z.enum(approvalStates);
export const auditEventTypeSchema = z.enum(auditEventTypes);
export const requestStatusSchema = z.enum(requestStatuses);
export const siteActivationStatusSchema = z.enum(siteActivationStatuses);
export const siteConnectionStatusSchema = z.enum(siteConnectionStatuses);
export const siteEnvironmentSchema = z.enum(siteEnvironments);
export const threadTypeSchema = z.enum(threadTypes);
export const toolInvocationStatusSchema = z.enum(toolInvocationStatuses);

export const localizedTextBlockSchema = z.object({
  format: z.enum(["plain_text", "markdown", "html"]),
  value: z.string().min(1),
  technicalDetails: z.string().max(20_000).optional()
});

export const imageAttachmentSchema = z.object({
  fileName: z.string().min(1).max(260),
  mediaType: z.string().regex(/^image\//),
  sizeBytes: z.number().int().nonnegative(),
  dataUrl: z.string().regex(/^data:image\//),
  /**
   * "media" (default) is placed in the content; "reference" is a layout or
   * content mock-up (e.g. a PDF page) the planner reads but never uploads.
   */
  purpose: z.enum(["media", "reference"]).optional()
});

export const actorSchema = z.object({
  userProfileId: idSchema,
  appRole: z.enum([
    "owner",
    "admin",
    "manager",
    "approver",
    "requester",
    "read_only_auditor"
  ]),
  siteRoles: z.array(
    z.enum([
      "request",
      "edit_drafts",
      "approve",
      "publish",
      "manage_config",
      "manage_connection",
      "audit_only"
    ])
  )
});

export const systemActorSchema = z.object({
  kind: z.enum(["system", "assistant"])
});

export const timestampsSchema = z.object({
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export type ImageAttachmentPayload = z.infer<typeof imageAttachmentSchema>;
