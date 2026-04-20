import { randomUUID } from "node:crypto";

import type {
  ApprovalDecision,
  ApprovalDecisionId,
  ApprovalRequest,
  ApprovalRequestId,
  AuditEntryId,
  Request,
  SiteId
} from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { DEFAULT_OPERATOR } from "./chat-service.js";

function nowIso(): string {
  return new Date().toISOString();
}

export type ListPendingApprovalsResult =
  | {
      ok: true;
      approvals: Array<{
        id: ApprovalRequest["id"];
        requestId: ApprovalRequest["requestId"];
        planId: ApprovalRequest["planId"];
        siteId: ApprovalRequest["siteId"];
        status: ApprovalRequest["status"];
        expiresAt?: ApprovalRequest["expiresAt"];
      }>;
    }
  | { ok: false; code: string; message: string };

export async function listPendingApprovalsForSite(
  siteId: SiteId
): Promise<ListPendingApprovalsResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  if (site.activationStatus !== "active") {
    return {
      ok: false,
      code: "site_not_active",
      message: "Site must be active to review approvals."
    };
  }

  const rows = await db.repositories.approvals.listPendingBySiteId(siteId);
  return {
    ok: true,
    approvals: rows.map((a) => ({
      id: a.id,
      requestId: a.requestId,
      planId: a.planId,
      siteId: a.siteId,
      status: a.status,
      ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {})
    }))
  };
}

export type DecideApprovalResult =
  | { ok: true; approval: ApprovalRequest }
  | { ok: false; code: string; message: string };

export async function decideApprovalForSite(input: {
  siteId: SiteId;
  approvalRequestId: ApprovalRequestId;
  decision: "approved" | "rejected" | "revision_requested";
  note?: string;
}): Promise<DecideApprovalResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(input.siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  if (site.activationStatus !== "active") {
    return {
      ok: false,
      code: "site_not_active",
      message: "Site must be active to decide approvals."
    };
  }

  const approval = await db.repositories.approvals.getById(
    input.approvalRequestId
  );
  if (!approval || approval.siteId !== input.siteId) {
    return {
      ok: false,
      code: "approval_not_found",
      message: "Approval request not found for this site."
    };
  }
  if (approval.status !== "pending") {
    return {
      ok: false,
      code: "approval_not_pending",
      message: "Only pending approvals can be decided."
    };
  }

  const ts = nowIso();
  const statusMap: Record<typeof input.decision, ApprovalRequest["status"]> = {
    approved: "approved",
    rejected: "rejected",
    revision_requested: "revision_requested"
  };
  const newStatus = statusMap[input.decision];

  const decisionRow: ApprovalDecision = {
    id: randomUUID() as ApprovalDecisionId,
    approvalRequestId: approval.id,
    decidedBy: DEFAULT_OPERATOR,
    decision: newStatus,
    ...(input.note !== undefined ? { note: input.note } : {}),
    createdAt: ts,
    updatedAt: ts
  };

  await db.repositories.approvals.appendDecision(decisionRow);

  const updated: ApprovalRequest = {
    ...approval,
    status: newStatus,
    updatedAt: ts
  };
  await db.repositories.approvals.save(updated);

  const request = await db.repositories.requests.getById(approval.requestId);
  if (request) {
    let nextStatus: Request["status"];
    if (input.decision === "approved") {
      nextStatus = "approved";
    } else {
      nextStatus = "drafted";
    }
    await db.repositories.requests.save({
      ...request,
      status: nextStatus,
      updatedAt: ts
    });
  }

  await db.repositories.auditEntries.append({
    id: randomUUID() as AuditEntryId,
    siteId: input.siteId,
    requestId: approval.requestId,
    eventType: "approval_decided",
    actor: DEFAULT_OPERATOR,
    metadata: {
      approvalRequestId: approval.id,
      decision: newStatus,
      ...(input.note !== undefined ? { note: input.note } : {})
    },
    createdAt: ts,
    updatedAt: ts
  });

  return { ok: true, approval: updated };
}
