import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ActorRef,
  ClientSource,
  SiteRole,
  UserProfileId
} from "@sitepilot/domain";

/** The single local user of the desktop app. */
export const DEFAULT_OPERATOR: ActorRef = {
  userProfileId: "local-operator" as UserProfileId,
  appRole: "requester",
  siteRoles: ["request"]
};

/**
 * Who is making the current call and through which client. Services read it
 * instead of assuming the desktop operator, so the same code serves the
 * desktop IPC layer and the SitePilot MCP server.
 */
export type CallContext = {
  actor: ActorRef;
  source: ClientSource;
  /** The MCP tool that started this call, for the audit trail. */
  tool?: string;
};

const storage = new AsyncLocalStorage<CallContext>();

const DESKTOP_CONTEXT: CallContext = {
  actor: DEFAULT_OPERATOR,
  source: "desktop"
};

export function runWithCallContext<T>(
  context: CallContext,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(context, fn);
}

export function currentCallContext(): CallContext {
  return storage.getStore() ?? DESKTOP_CONTEXT;
}

/** The current actor, tagged with the client it used. */
export function currentActor(): ActorRef {
  const context = currentCallContext();
  return { ...context.actor, source: context.source };
}

export type CallPermission = "read" | "request" | "approve";

const PERMISSION_SITE_ROLES: Record<CallPermission, readonly SiteRole[]> = {
  read: ["request", "edit_drafts", "approve", "publish", "audit_only"],
  request: ["request", "edit_drafts"],
  approve: ["approve"]
};

/**
 * Whether the current caller may do this. The desktop operator is trusted for
 * everything, since the person at the desktop is the one who approves. Every
 * other client needs a matching site role.
 */
export function callerMay(permission: CallPermission): boolean {
  const context = currentCallContext();
  if (context.source === "desktop") return true;
  const allowed = PERMISSION_SITE_ROLES[permission];
  return context.actor.siteRoles.some((role) => allowed.includes(role));
}

export function assertCallerMay(
  permission: CallPermission
): { ok: true } | { ok: false; code: "forbidden"; message: string } {
  if (callerMay(permission)) return { ok: true };
  const message =
    permission === "approve"
      ? "Approval has to happen in SitePilot, by a person with the approver role."
      : `This client is not allowed to ${permission === "read" ? "read site content" : "make requests"}.`;
  return { ok: false, code: "forbidden", message };
}
