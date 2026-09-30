import type {
  ChatThreadId,
  Request,
  RequestId,
  SiteId
} from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";

/** Read-only summary for a request made with the removed v1 engine. */
export type RequestBundleLegacyV1 = {
  plannedActionCount: number;
  lastRunStatus?: string;
};

export type GetRequestBundleResult =
  | {
      ok: true;
      request: Request;
      legacyV1: RequestBundleLegacyV1 | null;
    }
  | { ok: false; code: string; message: string };

async function legacyV1Summary(
  request: Request
): Promise<RequestBundleLegacyV1 | null> {
  if (
    request.latestPlanId === undefined &&
    request.latestExecutionRunId === undefined
  ) {
    return null;
  }
  const db = getDatabase();
  const plan =
    request.latestPlanId !== undefined
      ? await db.repositories.actionPlans
          .getById(request.latestPlanId)
          .catch(() => null)
      : null;
  const run =
    request.latestExecutionRunId !== undefined
      ? await db.repositories.executionRuns
          .getById(request.latestExecutionRunId)
          .catch(() => null)
      : null;
  return {
    plannedActionCount: plan?.proposedActions.length ?? 0,
    ...(run ? { lastRunStatus: run.status } : {})
  };
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
  return { ok: true, request, legacyV1: await legacyV1Summary(request) };
}
