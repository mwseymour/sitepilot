import { randomUUID } from "node:crypto";

import {
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
  enrichActionPlanWithPostLookupFromContext
} from "@sitepilot/services";
import { validateActionPlan } from "@sitepilot/validation";
import type { PlanValidationOutcome } from "@sitepilot/validation";

import { getDatabase } from "./app-database.js";
import { buildPlannerContextForThread } from "./planner-context-service.js";
import { getSecureStorage } from "./app-secure-storage.js";
import {
  loadPlannerPreferences,
  type PlannerPreferences
} from "./planner-preferences-service.js";

function nowIso(): string {
  return new Date().toISOString();
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
  const openaiKey = await storage.get({
    namespace: "provider",
    keyId: "openai"
  });
  const anthropicKey = await storage.get({
    namespace: "provider",
    keyId: "anthropic"
  });

  const chosen = choosePlannerProvider(prefs, openaiKey, anthropicKey);

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

  const validation = validateActionPlan(plan, {
    discoveryCapabilities: discovery?.capabilities ?? [],
    siteConfigPublishRequiresApproval: publishRequires
  });

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

  let requestStatus = request.status;
  if (validation.kind === "blocked_approval") {
    requestStatus = "awaiting_approval";
  } else if (request.status === "new" || request.status === "drafted") {
    requestStatus = "drafted";
  }

  await db.repositories.requests.save({
    ...request,
    latestPlanId: plan.id as ActionPlanId,
    status: requestStatus,
    updatedAt: ts
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId,
    requestId,
    eventType: "plan_generated",
    actor: { kind: "assistant" },
    metadata: {
      planId: plan.id,
      plannerMode: usage?.provider ?? "stub"
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
          messages: validation.messages
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
    validation.kind === "blocked_approval"
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
