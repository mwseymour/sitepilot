import { randomUUID } from "node:crypto";

import { normalizeMcpToolResult } from "@sitepilot/mcp-client";
import type {
  ActionId,
  ActionPlanId,
  AuditEntryId,
  ChatMessageId,
  ExecutionRun,
  ExecutionRunId,
  RequestId,
  SiteId,
  ToolInvocationId
} from "@sitepilot/domain";
import { actionToMcpToolCall } from "@sitepilot/services";

import { getDatabase } from "./app-database.js";
import { DEFAULT_OPERATOR } from "./chat-service.js";
import { createMcpClientForSite } from "./site-mcp-client.js";

export type ExecutePlanActionInput = {
  siteId: SiteId;
  requestId: RequestId;
  planId: ActionPlanId;
  actionId: ActionId;
  dryRun: boolean;
  idempotencyKey?: string;
};

export type ExecutePlanActionResult =
  | {
      ok: true;
      dryRun: boolean;
      skipped?: boolean;
      reused?: boolean;
      toolName?: string;
      mcpResult: Record<string, unknown>;
      executionRunId?: ExecutionRunId;
      toolInvocationId?: ToolInvocationId;
    }
  | { ok: false; code: string; message: string };

function nowIso(): string {
  return new Date().toISOString();
}

async function appendExecutionMessage(input: {
  siteId: SiteId;
  requestId: RequestId;
  author: { kind: "assistant" } | { kind: "system" };
  text: string;
}): Promise<void> {
  const db = getDatabase();
  const request = await db.repositories.requests.getById(input.requestId);
  if (!request || request.siteId !== input.siteId) {
    return;
  }

  const ts = nowIso();
  await db.repositories.chatMessages.save({
    id: randomUUID() as ChatMessageId,
    threadId: request.threadId,
    siteId: input.siteId,
    requestId: input.requestId,
    author: input.author,
    body: { format: "plain_text", value: input.text },
    createdAt: ts,
    updatedAt: ts
  });
}

async function reuseCompletedRun(
  idem: string,
  toolName: string
): Promise<ExecutePlanActionResult> {
  const db = getDatabase();
  const existing =
    await db.repositories.executionRuns.getByIdempotencyKey(idem);
  if (existing === null || existing.status !== "completed") {
    return {
      ok: false,
      code: "execution_reuse_failed",
      message: "Could not load completed execution for idempotency key."
    };
  }
  const invs = await db.repositories.toolInvocations.listByExecutionRunId(
    existing.id
  );
  const first = invs[0];
  return {
    ok: true,
    dryRun: false,
    reused: true,
    toolName,
    mcpResult: (first?.output as Record<string, unknown> | undefined) ?? {},
    executionRunId: existing.id,
    ...(first !== undefined ? { toolInvocationId: first.id } : {})
  };
}

export async function executePlanAction(
  input: ExecutePlanActionInput
): Promise<ExecutePlanActionResult> {
  const db = getDatabase();
  const request = await db.repositories.requests.getById(input.requestId);
  if (!request || request.siteId !== input.siteId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request not found for this site."
    };
  }

  if (!input.dryRun && request.status !== "approved") {
    return {
      ok: false,
      code: "not_approved",
      message: "Approve this request before executing actions on the site."
    };
  }

  const plan = await db.repositories.actionPlans.getById(input.planId);
  if (
    !plan ||
    plan.requestId !== input.requestId ||
    plan.siteId !== input.siteId
  ) {
    return {
      ok: false,
      code: "plan_not_found",
      message: "Action plan not found for this request."
    };
  }

  const action = plan.proposedActions.find((a) => a.id === input.actionId);
  if (!action) {
    return {
      ok: false,
      code: "action_not_found",
      message: "Action not in this plan."
    };
  }

  const spec = actionToMcpToolCall(action.type, action.input, input.dryRun);

  if (!spec) {
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: `Skipped action "${action.type}" because no MCP tool mapping is defined for it.`
    });
    return {
      ok: true,
      dryRun: input.dryRun,
      skipped: true,
      mcpResult: {
        reason: "no_remote_tool",
        actionType: action.type
      }
    };
  }

  const mcp = await createMcpClientForSite(input.siteId);
  if (!mcp.ok) {
    return mcp;
  }

  if (input.dryRun) {
    let raw: unknown;
    try {
      raw = await mcp.client.callTool(spec.toolName, spec.arguments);
    } catch (error) {
      await appendExecutionMessage({
        siteId: input.siteId,
        requestId: input.requestId,
        author: { kind: "system" },
        text: `Dry-run failed for ${spec.toolName}: ${error instanceof Error ? error.message : "MCP tool call failed."}`
      });
      return {
        ok: false,
        code: "mcp_call_failed",
        message:
          error instanceof Error ? error.message : "MCP tool call failed."
      };
    }
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "assistant" },
      text: `Dry-run completed for ${spec.toolName}.`
    });
    return {
      ok: true,
      dryRun: true,
      toolName: spec.toolName,
      mcpResult: normalizeMcpToolResult(raw)
    };
  }

  const idem =
    input.idempotencyKey ??
    `sitepilot:${input.siteId}:${input.requestId}:${input.planId}:${input.actionId}`;

  const prior = await db.repositories.executionRuns.getByIdempotencyKey(idem);
  if (prior !== null) {
    if (prior.status === "completed") {
      return reuseCompletedRun(idem, spec.toolName);
    }
    if (prior.status === "running") {
      return {
        ok: false,
        code: "execution_in_progress",
        message: "This action is already executing."
      };
    }
    return {
      ok: false,
      code: "execution_previous_failed",
      message:
        "A previous execution with this idempotency key failed. Pass a new idempotencyKey to retry."
    };
  }

  const ts = nowIso();
  const runId = randomUUID() as ExecutionRunId;
  const pendingRun: ExecutionRun = {
    id: runId,
    requestId: input.requestId,
    planId: input.planId,
    siteId: input.siteId,
    status: "running",
    idempotencyKey: idem,
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts
  };

  try {
    await db.repositories.executionRuns.save(pendingRun);
  } catch {
    const raced = await db.repositories.executionRuns.getByIdempotencyKey(idem);
    if (raced === null) {
      return {
        ok: false,
        code: "execution_persist_failed",
        message: "Could not record execution run."
      };
    }
    if (raced.status === "completed") {
      return reuseCompletedRun(idem, spec.toolName);
    }
    if (raced.status === "running") {
      return {
        ok: false,
        code: "execution_in_progress",
        message: "This action is already executing."
      };
    }
    return {
      ok: false,
      code: "execution_previous_failed",
      message:
        "A previous execution with this idempotency key failed. Pass a new idempotencyKey to retry."
    };
  }

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: input.requestId,
    actionId: input.actionId,
    eventType: "execution_started",
    actor: DEFAULT_OPERATOR,
    metadata: {
      executionRunId: runId,
      toolName: spec.toolName,
      idempotencyKey: idem
    },
    createdAt: ts,
    updatedAt: ts
  });

  let raw: unknown;
  try {
    raw = await mcp.client.callTool(spec.toolName, spec.arguments);
  } catch (error) {
    const failTs = nowIso();
    const invId = randomUUID() as ToolInvocationId;
    const message =
      error instanceof Error ? error.message : "MCP tool call failed.";
    await db.repositories.toolInvocations.save({
      id: invId,
      executionRunId: runId,
      actionId: input.actionId,
      toolName: spec.toolName,
      status: "failed",
      input: spec.arguments,
      errorCode: "mcp_call_failed",
      createdAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.executionRuns.save({
      ...pendingRun,
      status: "failed",
      completedAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId: input.siteId,
      requestId: input.requestId,
      actionId: input.actionId,
      eventType: "execution_failed",
      actor: DEFAULT_OPERATOR,
      metadata: {
        executionRunId: runId,
        toolName: spec.toolName,
        error: message
      },
      createdAt: failTs,
      updatedAt: failTs
    });
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: `Execution failed for ${spec.toolName}: ${message}`
    });
    return {
      ok: false,
      code: "mcp_call_failed",
      message
    };
  }

  const mcpResult = normalizeMcpToolResult(raw);
  const invId = randomUUID() as ToolInvocationId;
  const toolOk =
    mcpResult.ok === true ||
    (typeof mcpResult.ok === "boolean" && mcpResult.ok);

  if (!toolOk) {
    const failTs = nowIso();
    await db.repositories.toolInvocations.save({
      id: invId,
      executionRunId: runId,
      actionId: input.actionId,
      toolName: spec.toolName,
      status: "failed",
      input: spec.arguments,
      output: mcpResult,
      errorCode: "tool_reported_failure",
      createdAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.executionRuns.save({
      ...pendingRun,
      status: "failed",
      completedAt: failTs,
      updatedAt: failTs
    });
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId: input.siteId,
      requestId: input.requestId,
      actionId: input.actionId,
      eventType: "execution_failed",
      actor: DEFAULT_OPERATOR,
      metadata: {
        executionRunId: runId,
        toolName: spec.toolName,
        payload: mcpResult
      },
      createdAt: failTs,
      updatedAt: failTs
    });
    await appendExecutionMessage({
      siteId: input.siteId,
      requestId: input.requestId,
      author: { kind: "system" },
      text: `Execution failed for ${spec.toolName}: the site reported the action did not succeed.`
    });
    return {
      ok: false,
      code: "tool_reported_failure",
      message: "The site reported that the action did not succeed."
    };
  }

  const doneTs = nowIso();
  await db.repositories.toolInvocations.save({
    id: invId,
    executionRunId: runId,
    actionId: input.actionId,
    toolName: spec.toolName,
    status: "succeeded",
    input: spec.arguments,
    output: mcpResult,
    createdAt: doneTs,
    updatedAt: doneTs
  });

  await db.repositories.executionRuns.save({
    ...pendingRun,
    status: "completed",
    completedAt: doneTs,
    updatedAt: doneTs
  });

  await db.repositories.requests.save({
    ...request,
    latestExecutionRunId: runId,
    status: "completed",
    updatedAt: doneTs
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: input.requestId,
    actionId: input.actionId,
    eventType: "tool_invoked",
    actor: DEFAULT_OPERATOR,
    metadata: {
      executionRunId: runId,
      toolName: spec.toolName,
      toolInvocationId: invId
    },
    createdAt: doneTs,
    updatedAt: doneTs
  });

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: input.requestId,
    actionId: input.actionId,
    eventType: "execution_completed",
    actor: DEFAULT_OPERATOR,
    metadata: {
      executionRunId: runId,
      toolName: spec.toolName,
      idempotencyKey: idem
    },
    createdAt: doneTs,
    updatedAt: doneTs
  });

  const beforeSnap = mcpResult["before"];
  if (
    beforeSnap !== null &&
    typeof beforeSnap === "object" &&
    !Array.isArray(beforeSnap)
  ) {
    await db.repositories.auditEntries.append({
      id: randomUUID() as AuditEntryId,
      siteId: input.siteId,
      requestId: input.requestId,
      actionId: input.actionId,
      eventType: "rollback_recorded",
      actor: DEFAULT_OPERATOR,
      metadata: {
        executionRunId: runId,
        toolName: spec.toolName,
        toolInvocationId: invId,
        snapshot: {
          before: beforeSnap,
          after: mcpResult["after"] ?? null
        }
      },
      createdAt: doneTs,
      updatedAt: doneTs
    });
  }

  await appendExecutionMessage({
    siteId: input.siteId,
    requestId: input.requestId,
    author: { kind: "assistant" },
    text: `${input.dryRun ? "Dry-run completed" : "Execution completed"} for ${spec.toolName}.`
  });

  return {
    ok: true,
    dryRun: false,
    toolName: spec.toolName,
    mcpResult,
    executionRunId: runId,
    toolInvocationId: invId
  };
}
