import {
  siteConfigSchema,
  type ActionPlan as ContractActionPlan
} from "@sitepilot/contracts";
import type {
  ApprovalRequest,
  ChatThreadId,
  ExecutionRun,
  Request,
  RequestId,
  SiteId,
  ToolInvocation
} from "@sitepilot/domain";
import { validateActionPlan } from "@sitepilot/validation";

import { getDatabase } from "./app-database.js";
import {
  applyApprovalBypass,
  deriveRequestStatusAfterPlanning
} from "./plan-generation-service.js";
import { getSecureStorage } from "./app-secure-storage.js";
import { loadSitePlannerSettings } from "./settings-service.js";

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

async function loadSiteConfigPublishRequiresApproval(
  siteId: SiteId
): Promise<boolean> {
  const db = getDatabase();
  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const latestConfig = [...versions].sort((a, b) => b.version - a.version)[0];
  if (!latestConfig) {
    return false;
  }
  try {
    const cfg = siteConfigSchema.parse(latestConfig.document);
    return cfg.sections.approvalPolicy.publishRequiresApproval;
  } catch {
    return false;
  }
}

function shouldRecomputeRequestStatus(status: Request["status"]): boolean {
  return (
    status === "new" ||
    status === "drafted" ||
    status === "awaiting_approval" ||
    status === "approved"
  );
}

async function reconcileRequestStatusFromPlan(input: {
  request: Request;
  plan: ContractActionPlan | null;
}): Promise<Request> {
  if (!input.plan || !shouldRecomputeRequestStatus(input.request.status)) {
    return input.request;
  }

  const db = getDatabase();
  const [discovery, publishRequiresApproval, sitePlannerSettings] =
    await Promise.all([
      db.repositories.discoverySnapshots.getLatest(input.request.siteId),
      loadSiteConfigPublishRequiresApproval(input.request.siteId),
      loadSitePlannerSettings(getSecureStorage(), input.request.siteId)
    ]);

  const rawValidation = validateActionPlan(input.plan, {
    discoveryCapabilities: discovery?.capabilities ?? [],
    siteConfigPublishRequiresApproval: publishRequiresApproval
  });
  const validation = applyApprovalBypass(
    rawValidation,
    sitePlannerSettings.bypassApprovalRequests
  );
  const nextStatus = deriveRequestStatusAfterPlanning({
    currentStatus: input.request.status,
    rawValidation,
    validation
  });

  if (nextStatus === input.request.status) {
    return input.request;
  }

  const updatedRequest: Request = {
    ...input.request,
    status: nextStatus,
    updatedAt: new Date().toISOString()
  };
  await db.repositories.requests.save(updatedRequest);
  return updatedRequest;
}

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

  const effectiveRequest = await reconcileRequestStatusFromPlan({
    request,
    plan
  });

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
    request: effectiveRequest,
    plan,
    pendingApproval,
    lastExecution
  };
}
