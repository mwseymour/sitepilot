import type { ActionPlan as ContractActionPlan } from "@sitepilot/contracts";
import type {
  ApprovalRequest,
  ChatThreadId,
  ExecutionRun,
  Request,
  RequestId,
  SiteId,
  ToolInvocation
} from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

export type RequestBundlePendingApproval = {
  id: ApprovalRequest["id"];
  requestId: ApprovalRequest["requestId"];
  planId: ApprovalRequest["planId"];
  siteId: ApprovalRequest["siteId"];
  status: ApprovalRequest["status"];
  expiresAt?: ApprovalRequest["expiresAt"];
};

export type RequestBundleLastExecution = {
  id: ExecutionRun["id"];
  status: ExecutionRun["status"];
  idempotencyKey: string;
  toolInvocation?: {
    id: ToolInvocation["id"];
    toolName: ToolInvocation["toolName"];
    status: ToolInvocation["status"];
    input: ToolInvocation["input"];
    output?: ToolInvocation["output"];
    errorCode?: ToolInvocation["errorCode"];
  } | null;
  completedAt?: ExecutionRun["completedAt"];
};

export type GetRequestBundleResult =
  | {
      ok: true;
      request: Request;
      plan: ContractActionPlan | null;
      pendingApproval: RequestBundlePendingApproval | null;
      lastExecution: RequestBundleLastExecution | null;
    }
  | { ok: false; code: string; message: string };

export async function getRequestBundleForThread(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  requestId: RequestId;
}): Promise<GetRequestBundleResult> {
  const db = getDatabase();
  const request = await db.repositories.requests.getById(input.requestId);
  if (!request || request.siteId !== input.siteId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request not found for this site."
    };
  }
  if (request.threadId !== input.threadId) {
    return {
      ok: false,
      code: "thread_mismatch",
      message: "Request does not belong to this thread."
    };
  }

  let plan: ContractActionPlan | null = null;
  if (request.latestPlanId !== undefined) {
    try {
      plan = await db.repositories.actionPlans.getById(request.latestPlanId);
    } catch {
      plan = null;
    }
  }

  const approvals = await db.repositories.approvals.listByRequestId(
    input.requestId
  );
  const pending = approvals.find((a) => a.status === "pending");
  const pendingApproval: RequestBundlePendingApproval | null =
    pending !== undefined
      ? {
          id: pending.id,
          requestId: pending.requestId,
          planId: pending.planId,
          siteId: pending.siteId,
          status: pending.status,
          ...(pending.expiresAt !== undefined
            ? { expiresAt: pending.expiresAt }
            : {})
        }
      : null;

  let lastExecution: RequestBundleLastExecution | null = null;
  if (request.latestExecutionRunId !== undefined) {
    const run = await db.repositories.executionRuns.getById(
      request.latestExecutionRunId
    );
    if (run) {
      const invocations =
        await db.repositories.toolInvocations.listByExecutionRunId(run.id);
      const invocation = invocations.at(-1);
      lastExecution = {
        id: run.id,
        status: run.status,
        idempotencyKey: run.idempotencyKey,
        toolInvocation:
          invocation !== undefined
            ? {
                id: invocation.id,
                toolName: invocation.toolName,
                status: invocation.status,
                input: invocation.input,
                ...(invocation.output !== undefined
                  ? { output: invocation.output }
                  : {}),
                ...(invocation.errorCode !== undefined
                  ? { errorCode: invocation.errorCode }
                  : {})
              }
            : null,
        ...(run.completedAt !== undefined
          ? { completedAt: run.completedAt }
          : {})
      };
    }
  }

  return {
    ok: true,
    request,
    plan,
    pendingApproval,
    lastExecution
  };
}
