import { randomUUID } from "node:crypto";

import {
  actionPlanSchema,
  type ActionPlan,
  type PlannerContext
} from "@sitepilot/contracts";
import type {
  ActionId,
  ActionPlanId,
  RequestId,
  SiteId
} from "@sitepilot/domain";
import type {
  ChatMessage,
  ChatModelClient
} from "@sitepilot/provider-adapters";

import { extractJsonObject } from "./json-extract.js";

const PLANNER_PROMPT_VERSION = "sitepilot-plan-v1";

function lastUserPlainText(context: PlannerContext): string {
  const users = context.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return last?.text?.trim() ?? "(no user message)";
}

export function buildStubActionPlan(input: {
  context: PlannerContext;
  requestId: RequestId;
  siteId: SiteId;
  nowIso: string;
}): ActionPlan {
  const summary = lastUserPlainText(input.context);
  const planId = randomUUID() as ActionPlanId;
  const interpretId = randomUUID() as ActionId;
  const draftPostId = randomUUID() as ActionId;
  const draftTitle =
    summary.length > 80
      ? `Draft: ${summary.slice(0, 77)}…`
      : `Draft: ${summary}`;

  const draft: ActionPlan = {
    id: planId,
    requestId: input.requestId,
    siteId: input.siteId,
    requestSummary: summary.slice(0, 500),
    assumptions: [
      "Stub planner: no provider API key configured; this plan is a deterministic placeholder."
    ],
    openQuestions: [],
    targetEntities: [],
    proposedActions: [
      {
        id: interpretId,
        type: "interpret_request",
        version: 1,
        input: { summary },
        targetEntityRefs: [],
        permissionRequirement: "read_site",
        riskLevel: "low",
        dryRunCapable: true,
        rollbackSupported: true
      },
      {
        id: draftPostId,
        type: "create_draft_post",
        version: 1,
        input: {
          title: draftTitle,
          content: summary,
          post_type: "post"
        },
        targetEntityRefs: [],
        permissionRequirement: "edit_posts",
        riskLevel: "low",
        dryRunCapable: true,
        rollbackSupported: false
      }
    ],
    dependencies: [],
    approvalRequired: false,
    riskLevel: "low",
    rollbackNotes: [],
    validationWarnings: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };

  return actionPlanSchema.parse(draft);
}

export async function buildLlmActionPlan(input: {
  context: PlannerContext;
  requestId: RequestId;
  siteId: SiteId;
  nowIso: string;
  client: ChatModelClient;
  model: string;
}): Promise<{
  plan: ActionPlan;
  usage: { inputTokens: number; outputTokens: number; provider: string };
}> {
  const system = `You are SitePilot's planning engine. Reply with a single JSON object only (no markdown) that matches this shape:
{
  "requestSummary": string (non-empty),
  "assumptions": string[],
  "openQuestions": string[],
  "targetEntities": string[],
  "proposedActions": [{
    "id": string (unique id),
    "type": string (machine-readable action type),
    "version": positive int,
    "input": object (string keys to JSON values),
    "targetEntityRefs": string[],
    "permissionRequirement": string,
    "riskLevel": "low"|"medium"|"high"|"critical",
    "dryRunCapable": boolean,
    "rollbackSupported": boolean
  }] (at least one),
  "dependencies": string[],
  "approvalRequired": boolean,
  "riskLevel": "low"|"medium"|"high"|"critical",
  "rollbackNotes": string[],
  "validationWarnings": string[]
}
Use the operator request and site context. Keep actions conservative.
Use targetSummaries and priorChanges. If the thread already created a post or page and a later request is clearly modifying that same content, reuse that known entity and include its identifier such as post_id in the action input. Do not propose update actions without a concrete target id.`;

  const user = JSON.stringify(
    {
      plannerContext: input.context,
      requestId: input.requestId,
      siteId: input.siteId,
      promptVersion: PLANNER_PROMPT_VERSION
    },
    null,
    2
  );

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const result = await input.client.complete(messages, input.model);
  const raw = extractJsonObject(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Planner model returned non-JSON output.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Planner model JSON must be an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const planId = randomUUID() as ActionPlanId;
  const merged = {
    ...obj,
    id: planId,
    requestId: input.requestId,
    siteId: input.siteId,
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };

  const plan = actionPlanSchema.parse(merged);

  return {
    plan,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      provider: input.client.providerId
    }
  };
}
