import {
  plannerContextSchema,
  type PlannerContext,
  type SiteConfig
} from "@sitepilot/contracts";
import type { ChatMessage, DiscoverySnapshot } from "@sitepilot/domain";

function messageRole(m: ChatMessage): "user" | "assistant" | "system" {
  if (typeof m.author === "object" && m.author !== null && "kind" in m.author) {
    return m.author.kind === "assistant" ? "assistant" : "system";
  }
  return "user";
}

export type BuildPlannerContextInput = {
  siteId: string;
  threadId: string;
  builtAt: string;
  siteConfig: SiteConfig | null;
  discoverySnapshot: DiscoverySnapshot | null;
  activeSkills?: PlannerContext["activeSkills"];
  messages: ChatMessage[];
  targetSummaries?: string[];
  priorChanges?: string[];
};

/**
 * Assembles a reproducible planner payload from persisted site data (T21).
 */
export function buildPlannerContext(
  input: BuildPlannerContextInput
): PlannerContext {
  const payload: PlannerContext = {
    siteId: input.siteId,
    threadId: input.threadId,
    builtAt: input.builtAt,
    siteConfig: input.siteConfig,
    discoverySummary: input.discoverySnapshot
      ? input.discoverySnapshot.summary
      : null,
    ...(input.activeSkills !== undefined && input.activeSkills.length > 0
      ? { activeSkills: input.activeSkills }
      : {}),
    messages: input.messages.map((m) => ({
      messageId: m.id,
      role: messageRole(m),
      format: m.body.format,
      text: m.body.value,
      ...(m.attachments !== undefined && m.attachments.length > 0
        ? {
            attachments: m.attachments.map((attachment) => ({
              fileName: attachment.fileName,
              mediaType: attachment.mediaType,
              sizeBytes: attachment.sizeBytes
            }))
          }
        : {}),
      createdAt: m.createdAt,
      ...(m.requestId !== undefined ? { requestId: m.requestId } : {})
    })),
    targetSummaries: input.targetSummaries ?? [],
    priorChanges: input.priorChanges ?? []
  };

  return plannerContextSchema.parse(payload);
}
