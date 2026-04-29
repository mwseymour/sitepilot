import { randomUUID } from "node:crypto";

import {
  actionPlanSchema,
  siteConfigSchema,
  type ActionPlan as ContractActionPlan
} from "@sitepilot/contracts";
import type {
  ActionPlanId,
  ApprovalRequest,
  ApprovalRequestId,
  AuditEntryId,
  ChatMessageId,
  ChatThreadId,
  ProviderUsageEventId,
  RequestId,
  RequestStatus,
  SiteId
} from "@sitepilot/domain";
import {
  createAnthropicChatClient,
  createOpenAiChatClient,
  estimateUsageCostUsd
} from "@sitepilot/provider-adapters";
import {
  buildLlmActionPlan,
  buildStubActionPlan,
  enrichActionPlanWithPostLookupFromContext,
  requestNeedsVisualAnalysisReview,
  requestVisualAnalysisIsCurrent
} from "@sitepilot/services";
import { validateActionPlan } from "@sitepilot/validation";
import type { PlanValidationOutcome } from "@sitepilot/validation";

import { getDatabase } from "./app-database.js";
import { buildPlannerContextForThread } from "./planner-context-service.js";
import { sourceImagesForActionPlan } from "./image-sourcing-service.js";
import { getSecureStorage } from "./app-secure-storage.js";
import {
  loadPlannerPreferences,
  type PlannerPreferences
} from "./planner-preferences-service.js";
import { loadSitePlannerSettings } from "./settings-service.js";

function nowIso(): string {
  return new Date().toISOString();
}

const BLOCK_REMOVAL_TARGETS = [
  {
    labels: ["image", "images", "photo", "photos", "picture", "pictures"],
    blockNames: ["core/image"]
  },
  {
    labels: ["button", "buttons", "cta", "call to action"],
    blockNames: ["core/button", "core/buttons"]
  },
  {
    labels: ["spacer", "spacers", "gap", "gaps", "space block"],
    blockNames: ["core/spacer"]
  },
  {
    labels: ["separator", "separators", "divider", "dividers", "line", "lines", "rule"],
    blockNames: ["core/separator"]
  },
  {
    labels: ["heading", "headings", "title", "titles", "header", "headers"],
    blockNames: ["core/heading"]
  },
  {
    labels: ["paragraph", "paragraphs", "text block", "text blocks"],
    blockNames: ["core/paragraph"]
  },
  {
    labels: ["list", "lists", "bullet", "bullets"],
    blockNames: ["core/list", "core/list-item"]
  },
  {
    labels: ["quote", "quotes", "pullquote"],
    blockNames: ["core/quote", "core/pullquote"]
  },
  {
    labels: ["group", "groups", "card", "cards", "section", "sections", "container", "containers"],
    blockNames: ["core/group"]
  },
  {
    labels: ["column", "columns"],
    blockNames: ["core/column", "core/columns"]
  },
  {
    labels: ["table", "tables"],
    blockNames: ["core/table"]
  },
  {
    labels: ["video", "videos"],
    blockNames: ["core/video"]
  },
  {
    labels: ["code", "code block", "preformatted"],
    blockNames: ["core/code", "core/preformatted"]
  }
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRequestedBlockRemovals(requestText: string): {
  blockNames: Set<string>;
  labels: string[];
} {
  const normalized = requestText.toLowerCase();
  const isBroadRewrite =
    /\b(rebuild|redo|rewrite|replace|start over|from scratch|clear everything|remove everything|delete everything)\b/i.test(
      normalized
    );
  if (isBroadRewrite) {
    return { blockNames: new Set<string>(), labels: [] };
  }

  const hasRemovalIntent =
    /\b(remove|delete|drop|omit|without|use no|no)\b/i.test(normalized);
  if (!hasRemovalIntent) {
    return { blockNames: new Set<string>(), labels: [] };
  }

  const blockNames = new Set<string>();
  const labels: string[] = [];
  for (const target of BLOCK_REMOVAL_TARGETS) {
    const matchesTarget = target.labels.some((label) => {
      const escaped = escapeRegExp(label);
      return (
        new RegExp(`\\b(?:remove|delete|drop|omit)\\b[\\s\\S]{0,40}\\b${escaped}\\b`, "i").test(normalized) ||
        new RegExp(`\\bwithout\\b[\\s\\S]{0,20}\\b${escaped}\\b`, "i").test(normalized) ||
        new RegExp(`\\buse\\s+no\\s+${escaped}\\b`, "i").test(normalized) ||
        new RegExp(`\\bno\\s+${escaped}\\b`, "i").test(normalized)
      );
    });
    if (!matchesTarget) {
      continue;
    }
    target.blockNames.forEach((blockName) => blockNames.add(blockName));
    labels.push(target.labels[0]);
  }

  return { blockNames, labels };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBlockName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function extractBlocksFromAction(
  action: ContractActionPlan["proposedActions"][number] | undefined
): unknown[] {
  const input = objectValue(action?.input);
  return Array.isArray(input.blocks) ? input.blocks : [];
}

function hasStructuredLayoutBlocks(blocks: unknown[]): boolean {
  return blocks.some((block) => {
    const name = normalizeBlockName(objectValue(block).blockName);
    return (
      name === "core/columns" ||
      name === "core/column" ||
      name === "core/group" ||
      name === "core/buttons" ||
      name === "core/button" ||
      name === "core/image" ||
      name === "core/spacer" ||
      name === "core/separator"
    );
  });
}

function stripRequestedBlocks(
  blocks: unknown[],
  removableBlockNames: Set<string>
): unknown[] {
  const cleaned: unknown[] = [];
  for (const rawBlock of blocks) {
    const block = objectValue(rawBlock);
    const name = normalizeBlockName(block.blockName);
    if (removableBlockNames.has(name)) {
      continue;
    }

    const innerBlocks = Array.isArray(block.innerBlocks)
      ? stripRequestedBlocks(block.innerBlocks, removableBlockNames)
      : [];

    cleaned.push({
      ...block,
      innerBlocks
    });
  }
  return cleaned;
}

export function preserveStructuredLayoutForNarrowBlockRevision(input: {
  plan: ContractActionPlan;
  previousPlan: ContractActionPlan | null;
  requestText: string;
}): ContractActionPlan {
  const currentAction = input.plan.proposedActions[0];
  const previousAction = input.previousPlan?.proposedActions[0];
  if (!currentAction || !previousAction) {
    return input.plan;
  }

  const currentInput = objectValue(currentAction.input);
  const currentBlocks = extractBlocksFromAction(currentAction);
  const currentContent =
    typeof currentInput.content === "string" ? currentInput.content.trim() : "";
  const previousBlocks = extractBlocksFromAction(previousAction);
  const removalTargets = extractRequestedBlockRemovals(input.requestText);
  if (
    currentBlocks.length > 0 ||
    currentContent.length === 0 ||
    previousBlocks.length === 0 ||
    !hasStructuredLayoutBlocks(previousBlocks) ||
    removalTargets.blockNames.size === 0
  ) {
    return input.plan;
  }

  const strippedBlocks = stripRequestedBlocks(
    previousBlocks,
    removalTargets.blockNames
  );
  if (
    strippedBlocks.length === 0 ||
    JSON.stringify(strippedBlocks) === JSON.stringify(previousBlocks)
  ) {
    return input.plan;
  }

  const updatedWarnings = [
    ...input.plan.validationWarnings,
    `Preserved the previous structured block layout for this revision and removed only the requested block types (${removalTargets.labels.join(", ")}) instead of replacing the whole body with flattened text.`
  ];

  const proposedActions = input.plan.proposedActions.map((action, index) => {
    if (index !== 0) {
      return action;
    }
    const nextInput = {
      ...objectValue(action.input),
      blocks: strippedBlocks
    } as Record<string, unknown>;
    delete nextInput.content;
    delete nextInput.postContent;
    delete nextInput.post_content;
    return {
      ...action,
      input: nextInput
    };
  });

  return actionPlanSchema.parse({
    ...input.plan,
    proposedActions,
    validationWarnings: [...new Set(updatedWarnings)]
  });
}

export function applyApprovalBypass(
  validation: PlanValidationOutcome,
  bypassApprovalRequests: boolean
): PlanValidationOutcome {
  if (!bypassApprovalRequests || validation.kind !== "blocked_approval") {
    return validation;
  }
  return {
    kind: "warnings",
    messages: ["Site settings bypassed the approval gate for this plan."]
  };
}

export function deriveRequestStatusAfterPlanning(input: {
  currentStatus: RequestStatus;
  rawValidation: PlanValidationOutcome;
  validation: PlanValidationOutcome;
}): RequestStatus {
  const approvalBypassApplied =
    input.rawValidation.kind === "blocked_approval" &&
    input.validation.kind !== "blocked_approval";

  if (approvalBypassApplied) {
    return "approved";
  }
  if (input.validation.kind === "blocked_approval") {
    return "awaiting_approval";
  }
  if (
    input.validation.kind === "pass" ||
    input.validation.kind === "warnings"
  ) {
    return "approved";
  }
  return input.currentStatus;
}

type ChosenProvider =
  | { kind: "openai"; key: string; model: string }
  | { kind: "anthropic"; key: string; model: string }
  | { kind: "stub" };

function choosePlannerProvider(
  prefs: PlannerPreferences,
  openaiKey: string | undefined,
  anthropicKey: string | undefined
): ChosenProvider {
  const openai = (): ChosenProvider | null =>
    openaiKey !== undefined
      ? { kind: "openai", key: openaiKey, model: prefs.openaiModel }
      : null;
  const anthropic = (): ChosenProvider | null =>
    anthropicKey !== undefined
      ? { kind: "anthropic", key: anthropicKey, model: prefs.anthropicModel }
      : null;

  if (prefs.preferredProvider === "openai") {
    return openai() ?? anthropic() ?? { kind: "stub" };
  }
  if (prefs.preferredProvider === "anthropic") {
    return anthropic() ?? openai() ?? { kind: "stub" };
  }
  return openai() ?? anthropic() ?? { kind: "stub" };
}

export type GenerateActionPlanResult =
  | { ok: true; plan: ContractActionPlan; validation: PlanValidationOutcome }
  | { ok: false; code: string; message: string };

export async function generateActionPlanForRequest(
  siteId: SiteId,
  threadId: ChatThreadId,
  requestId: RequestId
): Promise<GenerateActionPlanResult> {
  const db = getDatabase();
  const request = await db.repositories.requests.getById(requestId);
  if (!request || request.siteId !== siteId || request.threadId !== threadId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request not found for this thread."
    };
  }

  if (request.status === "clarifying") {
    return {
      ok: false,
      code: "request_clarifying",
      message: "Resolve clarification before generating a plan."
    };
  }

  const previousPlan =
    request.latestPlanId !== undefined
      ? await db.repositories.actionPlans.getById(request.latestPlanId)
      : null;

  const ctxResult = await buildPlannerContextForThread(siteId, threadId);
  if (!ctxResult.ok) {
    return ctxResult;
  }

  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }

  const discovery = await db.repositories.discoverySnapshots.getLatest(siteId);
  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const latestConfig = [...versions].sort((a, b) => b.version - a.version)[0];
  let publishRequires = false;
  if (latestConfig) {
    try {
      const cfg = siteConfigSchema.parse(latestConfig.document);
      publishRequires = cfg.sections.approvalPolicy.publishRequiresApproval;
    } catch {
      publishRequires = false;
    }
  }

  const ts = nowIso();
  const storage = getSecureStorage();
  const prefs = await loadPlannerPreferences(storage, site.workspaceId);
  const sitePlannerSettings = await loadSitePlannerSettings(storage, siteId);
  const openaiKey = await storage.get({
    namespace: "provider",
    keyId: "openai"
  });
  const anthropicKey = await storage.get({
    namespace: "provider",
    keyId: "anthropic"
  });

  const chosen = choosePlannerProvider(prefs, openaiKey, anthropicKey);
  const requestVisualAnalysis =
    await db.repositories.requestVisualAnalyses.getByRequestId(requestId);
  const visualAnalysisRequired = requestNeedsVisualAnalysisReview({
    userPrompt: request.userPrompt,
    attachments: request.attachments
  });
  if (
    visualAnalysisRequired &&
    !requestVisualAnalysisIsCurrent(request.updatedAt, requestVisualAnalysis)
  ) {
    return {
      ok: false,
      code: "request_visual_analysis_review_required",
      message:
        "Review and approve a current screenshot analysis before generating an action plan for this request."
    };
  }

  let plan: ContractActionPlan;
  let usage:
    | {
        inputTokens: number;
        outputTokens: number;
        provider: "openai" | "anthropic";
        model: string;
      }
    | undefined;

  if (chosen.kind === "openai") {
    const client = createOpenAiChatClient(chosen.key);
    try {
      const result = await buildLlmActionPlan({
        context: ctxResult.context,
        requestId,
        siteId,
        nowIso: ts,
        ...(request.attachments !== undefined
          ? { requestAttachments: request.attachments }
          : {}),
        ...(requestVisualAnalysis !== null
          ? { requestVisualAnalysis }
          : {}),
        client,
        model: chosen.model
      });
      plan = result.plan;
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        provider: "openai",
        model: chosen.model
      };
    } catch (error) {
      return {
        ok: false,
        code: "planner_model_failed",
        message:
          error instanceof Error ? error.message : "Planner model call failed."
      };
    }
  } else if (chosen.kind === "anthropic") {
    const client = createAnthropicChatClient(chosen.key);
    try {
      const result = await buildLlmActionPlan({
        context: ctxResult.context,
        requestId,
        siteId,
        nowIso: ts,
        ...(request.attachments !== undefined
          ? { requestAttachments: request.attachments }
          : {}),
        ...(requestVisualAnalysis !== null
          ? { requestVisualAnalysis }
          : {}),
        client,
        model: chosen.model
      });
      plan = result.plan;
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        provider: "anthropic",
        model: chosen.model
      };
    } catch (error) {
      return {
        ok: false,
        code: "planner_model_failed",
        message:
          error instanceof Error ? error.message : "Planner model call failed."
      };
    }
  } else {
    plan = buildStubActionPlan({
      context: ctxResult.context,
      requestId,
      siteId,
      nowIso: ts
    });
  }

  plan = enrichActionPlanWithPostLookupFromContext(plan, ctxResult.context);
  plan = await sourceImagesForActionPlan({
    plan,
    requestText: request.userPrompt,
    hasAttachments:
      request.attachments !== undefined && request.attachments.length > 0
  });
  plan = preserveStructuredLayoutForNarrowBlockRevision({
    plan,
    previousPlan,
    requestText: request.userPrompt
  });

  const rawValidation = validateActionPlan(plan, {
    discoveryCapabilities: discovery?.capabilities ?? [],
    siteConfigPublishRequiresApproval: publishRequires
  });
  const validation = applyApprovalBypass(
    rawValidation,
    sitePlannerSettings.bypassApprovalRequests
  );

  await db.repositories.actionPlans.saveFromContract(plan);

  if (usage) {
    const estimatedCostUsd = estimateUsageCostUsd(usage.provider, usage.model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens
    });
    await db.repositories.providerUsage.append({
      id: randomUUID() as ProviderUsageEventId,
      workspaceId: site.workspaceId,
      siteId,
      requestId,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd,
      createdAt: ts
    });
  }

  const approvalBypassApplied =
    rawValidation.kind === "blocked_approval" &&
    validation.kind !== "blocked_approval";
  const requestStatus = deriveRequestStatusAfterPlanning({
    currentStatus: request.status,
    rawValidation,
    validation
  });

  await db.repositories.requests.save({
    ...request,
    latestPlanId: plan.id as ActionPlanId,
    status: requestStatus,
    updatedAt: request.updatedAt
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId,
    requestId,
    eventType: "plan_generated",
    actor: { kind: "assistant" },
    metadata: {
      planId: plan.id,
      plannerMode: usage?.provider ?? "stub",
      approvalBypassApplied
    },
    createdAt: ts,
    updatedAt: ts
  });

  const validationMeta =
    validation.kind === "pass"
      ? { planId: plan.id, validation: validation.kind }
      : {
          planId: plan.id,
          validation: validation.kind,
          messages: validation.messages,
          ...(approvalBypassApplied
            ? { originalValidation: rawValidation.kind }
            : {})
        };

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId,
    requestId,
    eventType: "plan_validated",
    actor: { kind: "system" },
    metadata: validationMeta,
    createdAt: ts,
    updatedAt: ts
  });

  if (validation.kind === "blocked_approval") {
    const approval: ApprovalRequest = {
      id: randomUUID() as ApprovalRequestId,
      requestId,
      planId: plan.id as ActionPlanId,
      siteId,
      status: "pending",
      requestedBy: request.requestedBy,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: ts,
      updatedAt: ts
    };
    await db.repositories.approvals.save(approval);
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId,
      requestId,
      eventType: "approval_requested",
      actor: { kind: "system" },
      metadata: { approvalRequestId: approval.id, planId: plan.id },
      createdAt: ts,
      updatedAt: ts
    });
  }

  const actionSummary = plan.proposedActions
    .slice(0, 5)
    .map((action, index) => `${index + 1}. ${action.type}`)
    .join("\n");
  const validationSummary =
    validation.kind === "pass"
      ? "Plan validation passed."
      : validation.messages.length > 0
        ? `Validation: ${validation.messages.join(" ")}`
        : `Validation: ${validation.kind}.`;
  const approvalSummary =
    approvalBypassApplied
      ? "Approval would normally be required, but the site approval bypass is enabled."
      : validation.kind === "blocked_approval"
      ? "Approval is required before execution."
      : "No approval block detected for planning.";

  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId,
    siteId,
    requestId,
    author: { kind: "assistant" },
    body: {
      format: "plain_text",
      value: `Action plan generated with ${plan.proposedActions.length} action${plan.proposedActions.length === 1 ? "" : "s"}.\n${validationSummary}\n${approvalSummary}${actionSummary.length > 0 ? `\n\nPlanned actions:\n${actionSummary}` : ""}`
    },
    createdAt: ts,
    updatedAt: ts
  });

  return { ok: true, plan, validation };
}
