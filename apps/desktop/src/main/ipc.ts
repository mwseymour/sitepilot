import { app, ipcMain } from "electron";

import {
  actionPlanSchema,
  ipcChannels,
  ipcContracts,
  requestSchema,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse
} from "@sitepilot/contracts";
import type {
  ActionId,
  ActionPlanId,
  ApprovalRequestId,
  ChatThreadId,
  Request,
  RequestId,
  SiteConfigId,
  SiteId,
  Workspace,
  WorkspaceId
} from "@sitepilot/domain";

import {
  decideApprovalForSite,
  listPendingApprovalsForSite
} from "./approval-workflow-service.js";
import { listAuditEntriesForSite } from "./audit-query-service.js";
import {
  amendRequestForThread,
  answerClarificationForRequest,
  createChatThreadForSite,
  createTypedRequestForThread,
  listChatMessagesForThread,
  listChatThreadsForSite,
  postChatMessage
} from "./chat-service.js";
import { runConnectivityDiagnostics } from "./connectivity-diagnostics.js";
import { getDatabase } from "./app-database.js";
import { refreshDiscoveryForSite } from "./discovery-service.js";
import { generateAndPersistSiteConfigDraft } from "./site-config-draft.js";
import {
  confirmSiteConfigActivation,
  getSiteWorkspaceState,
  saveSiteConfigDocument
} from "./site-workspace-service.js";
import { buildPlannerContextForThread } from "./planner-context-service.js";
import { generateActionPlanForRequest } from "./plan-generation-service.js";
import { readProviderStatus } from "./provider-status-service.js";
import { registerSiteWithWordPress } from "./register-site.js";
import { getRequestBundleForThread } from "./request-bundle-service.js";
import { getCompatibilityPayload } from "./compatibility-info.js";
import { executePlanAction } from "./execution-orchestrator-service.js";
import { buildSiteExportBundle } from "./export-site-service.js";
import { applySiteImportBundle } from "./import-site-service.js";
import {
  clearProviderSecret,
  clearSiteSigningSecret,
  getSettingsState,
  setPlannerPreferences,
  setProviderSecret
} from "./settings-service.js";

function parseRequest<TChannel extends IpcChannel>(
  channel: TChannel,
  payload: unknown
): IpcRequest<TChannel> {
  return ipcContracts[channel].request.parse(payload);
}

function parseResponse<TChannel extends IpcChannel>(
  channel: TChannel,
  payload: unknown
): IpcResponse<TChannel> {
  return ipcContracts[channel].response.parse(payload);
}

function contractRequestPayload(entity: Request) {
  return requestSchema.parse({
    id: entity.id,
    siteId: entity.siteId,
    threadId: entity.threadId,
    requestedBy: entity.requestedBy,
    status: entity.status,
    userPrompt: entity.userPrompt,
    ...(entity.latestPlanId !== undefined
      ? { latestPlanId: entity.latestPlanId }
      : {}),
    ...(entity.latestExecutionRunId !== undefined
      ? { latestExecutionRunId: entity.latestExecutionRunId }
      : {}),
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  });
}

export function registerIpcHandlers(): void {
  ipcMain.handle(ipcChannels.getShellInfo, (_event, payload) => {
    parseRequest(ipcChannels.getShellInfo, payload);

    return parseResponse(ipcChannels.getShellInfo, {
      appName: "SitePilot",
      appVersion: app.getVersion(),
      rendererVersion: "0.1.0"
    });
  });

  ipcMain.handle(ipcChannels.listWorkspaces, async (_event, payload) => {
    parseRequest(ipcChannels.listWorkspaces, payload);

    const db = getDatabase();
    const workspaces = await db.repositories.workspaces.list();

    return parseResponse(ipcChannels.listWorkspaces, {
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug
      }))
    });
  });

  ipcMain.handle(ipcChannels.listSites, async (_event, payload) => {
    const request = parseRequest(ipcChannels.listSites, payload);

    const db = getDatabase();
    const workspaceId = (request.workspaceId ??
      "workspace-1") as Workspace["id"];
    const sites = await db.repositories.sites.listByWorkspaceId(workspaceId);

    return parseResponse(ipcChannels.listSites, {
      sites: sites.map((s) => ({
        id: s.id,
        workspaceId: s.workspaceId,
        name: s.name,
        baseUrl: s.baseUrl,
        environment: s.environment,
        activationStatus: s.activationStatus
      }))
    });
  });

  ipcMain.handle(ipcChannels.runSiteDiagnostics, async (_event, payload) => {
    const request = parseRequest(ipcChannels.runSiteDiagnostics, payload);
    const result = await runConnectivityDiagnostics(request.siteId);
    return parseResponse(ipcChannels.runSiteDiagnostics, result);
  });

  ipcMain.handle(ipcChannels.refreshSiteDiscovery, async (_event, payload) => {
    const request = parseRequest(ipcChannels.refreshSiteDiscovery, payload);
    const result = await refreshDiscoveryForSite(request.siteId);
    return parseResponse(ipcChannels.refreshSiteDiscovery, result);
  });

  ipcMain.handle(
    ipcChannels.generateSiteConfigDraft,
    async (_event, payload) => {
      const request = parseRequest(
        ipcChannels.generateSiteConfigDraft,
        payload
      );
      const result = await generateAndPersistSiteConfigDraft(
        request.siteId as SiteId
      );
      return parseResponse(ipcChannels.generateSiteConfigDraft, result);
    }
  );

  ipcMain.handle(ipcChannels.getSiteWorkspace, async (_event, payload) => {
    const request = parseRequest(ipcChannels.getSiteWorkspace, payload);
    const result = await getSiteWorkspaceState(request.siteId as SiteId);
    return parseResponse(ipcChannels.getSiteWorkspace, result);
  });

  ipcMain.handle(ipcChannels.saveSiteConfig, async (_event, payload) => {
    const request = parseRequest(ipcChannels.saveSiteConfig, payload);
    const result = await saveSiteConfigDocument(
      request.siteId as SiteId,
      request.siteConfig
    );
    return parseResponse(ipcChannels.saveSiteConfig, result);
  });

  ipcMain.handle(ipcChannels.confirmSiteConfig, async (_event, payload) => {
    const request = parseRequest(ipcChannels.confirmSiteConfig, payload);
    const result = await confirmSiteConfigActivation(
      request.siteId as SiteId,
      request.configId as SiteConfigId
    );
    return parseResponse(ipcChannels.confirmSiteConfig, result);
  });

  ipcMain.handle(ipcChannels.listChatThreads, async (_event, payload) => {
    const request = parseRequest(ipcChannels.listChatThreads, payload);
    const result = await listChatThreadsForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.listChatThreads, result);
  });

  ipcMain.handle(ipcChannels.createChatThread, async (_event, payload) => {
    const request = parseRequest(ipcChannels.createChatThread, payload);
    const result = await createChatThreadForSite(request.siteId as SiteId, {
      title: request.title,
      ...(request.type !== undefined ? { type: request.type } : {})
    });
    return parseResponse(ipcChannels.createChatThread, result);
  });

  ipcMain.handle(ipcChannels.listChatMessages, async (_event, payload) => {
    const request = parseRequest(ipcChannels.listChatMessages, payload);
    const result = await listChatMessagesForThread(
      request.siteId as SiteId,
      request.threadId as ChatThreadId
    );
    return parseResponse(ipcChannels.listChatMessages, result);
  });

  ipcMain.handle(ipcChannels.postChatMessage, async (_event, payload) => {
    const request = parseRequest(ipcChannels.postChatMessage, payload);
    const result = await postChatMessage(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.text
    );
    return parseResponse(ipcChannels.postChatMessage, result);
  });

  ipcMain.handle(ipcChannels.createChatRequest, async (_event, payload) => {
    const request = parseRequest(ipcChannels.createChatRequest, payload);
    const result = await createTypedRequestForThread(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.userPrompt
    );
    if (!result.ok) {
      return parseResponse(ipcChannels.createChatRequest, result);
    }
    return parseResponse(ipcChannels.createChatRequest, {
      ok: true,
      request: result.request,
      ...(result.clarificationRound !== undefined
        ? { clarificationRound: result.clarificationRound }
        : {})
    });
  });

  ipcMain.handle(ipcChannels.amendRequest, async (_event, payload) => {
    const request = parseRequest(ipcChannels.amendRequest, payload);
    const result = await amendRequestForThread(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.requestId as RequestId,
      request.text
    );
    if (!result.ok) {
      return parseResponse(ipcChannels.amendRequest, result);
    }
    return parseResponse(ipcChannels.amendRequest, {
      ok: true,
      request: result.request,
      ...(result.clarificationRound !== undefined
        ? { clarificationRound: result.clarificationRound }
        : {})
    });
  });

  ipcMain.handle(ipcChannels.answerClarification, async (_event, payload) => {
    const request = parseRequest(ipcChannels.answerClarification, payload);
    const result = await answerClarificationForRequest(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.requestId as RequestId,
      request.answer
    );
    if (!result.ok) {
      return parseResponse(ipcChannels.answerClarification, result);
    }
    return parseResponse(ipcChannels.answerClarification, {
      ok: true,
      request: result.request,
      ...(result.clarificationRound !== undefined
        ? { clarificationRound: result.clarificationRound }
        : {})
    });
  });

  ipcMain.handle(ipcChannels.buildPlannerContext, async (_event, payload) => {
    const request = parseRequest(ipcChannels.buildPlannerContext, payload);
    const result = await buildPlannerContextForThread(
      request.siteId as SiteId,
      request.threadId as ChatThreadId
    );
    return parseResponse(ipcChannels.buildPlannerContext, result);
  });

  ipcMain.handle(ipcChannels.generateActionPlan, async (_event, payload) => {
    const request = parseRequest(ipcChannels.generateActionPlan, payload);
    const result = await generateActionPlanForRequest(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.requestId as RequestId
    );
    return parseResponse(ipcChannels.generateActionPlan, result);
  });

  ipcMain.handle(ipcChannels.listPendingApprovals, async (_event, payload) => {
    const request = parseRequest(ipcChannels.listPendingApprovals, payload);
    const result = await listPendingApprovalsForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.listPendingApprovals, result);
  });

  ipcMain.handle(ipcChannels.decideApproval, async (_event, payload) => {
    const request = parseRequest(ipcChannels.decideApproval, payload);
    const result = await decideApprovalForSite({
      siteId: request.siteId as SiteId,
      approvalRequestId: request.approvalRequestId as ApprovalRequestId,
      decision: request.decision,
      ...(request.note !== undefined ? { note: request.note } : {})
    });
    if (!result.ok) {
      return parseResponse(ipcChannels.decideApproval, result);
    }
    const a = result.approval;
    return parseResponse(ipcChannels.decideApproval, {
      ok: true,
      approval: {
        id: a.id,
        requestId: a.requestId,
        planId: a.planId,
        siteId: a.siteId,
        status: a.status,
        ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {})
      }
    });
  });

  ipcMain.handle(ipcChannels.listAuditEntries, async (_event, payload) => {
    const request = parseRequest(ipcChannels.listAuditEntries, payload);
    const result = await listAuditEntriesForSite({
      siteId: request.siteId as SiteId,
      ...(request.requestId !== undefined
        ? { requestId: request.requestId as RequestId }
        : {}),
      ...(request.actionId !== undefined
        ? { actionId: request.actionId as ActionId }
        : {}),
      ...(request.eventTypes !== undefined && request.eventTypes.length > 0
        ? { eventTypes: request.eventTypes }
        : {}),
      ...(request.since !== undefined ? { since: request.since } : {}),
      ...(request.until !== undefined ? { until: request.until } : {}),
      ...(request.executionOutcome !== undefined
        ? { executionOutcome: request.executionOutcome }
        : {}),
      ...(request.rollbackRelatedOnly === true
        ? { rollbackRelatedOnly: true }
        : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {})
    });
    if (!result.ok) {
      return parseResponse(ipcChannels.listAuditEntries, result);
    }
    return parseResponse(ipcChannels.listAuditEntries, {
      ok: true,
      entries: result.entries.map((e) => ({
        id: e.id,
        siteId: e.siteId,
        eventType: e.eventType,
        actor: e.actor,
        metadata: e.metadata,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
        ...(e.actionId !== undefined ? { actionId: e.actionId } : {})
      }))
    });
  });

  ipcMain.handle(ipcChannels.registerSite, async (_event, payload) => {
    const request = parseRequest(ipcChannels.registerSite, payload);
    const forward: Parameters<typeof registerSiteWithWordPress>[0] = {
      baseUrl: request.baseUrl,
      registrationCode: request.registrationCode,
      siteName: request.siteName
    };
    if (request.wordpressUsername !== undefined) {
      forward.wordpressUsername = request.wordpressUsername;
    }
    if (request.workspaceId !== undefined) {
      forward.workspaceId = request.workspaceId;
    }
    if (request.environment !== undefined) {
      forward.environment = request.environment;
    }
    if (request.trustedAppOrigin !== undefined) {
      forward.trustedAppOrigin = request.trustedAppOrigin;
    }
    const result = await registerSiteWithWordPress(forward);
    return parseResponse(ipcChannels.registerSite, result);
  });

  ipcMain.handle(ipcChannels.getProviderStatus, async (_event, payload) => {
    parseRequest(ipcChannels.getProviderStatus, payload);
    const status = await readProviderStatus();
    return parseResponse(ipcChannels.getProviderStatus, status);
  });

  ipcMain.handle(ipcChannels.getRequestBundle, async (_event, payload) => {
    const req = parseRequest(ipcChannels.getRequestBundle, payload);
    const bundle = await getRequestBundleForThread({
      siteId: req.siteId as SiteId,
      threadId: req.threadId as ChatThreadId,
      requestId: req.requestId as RequestId
    });
    if (!bundle.ok) {
      return parseResponse(ipcChannels.getRequestBundle, bundle);
    }
    return parseResponse(ipcChannels.getRequestBundle, {
      ok: true,
      request: contractRequestPayload(bundle.request),
      plan: bundle.plan === null ? null : actionPlanSchema.parse(bundle.plan),
      pendingApproval:
        bundle.pendingApproval === null
          ? null
          : {
              id: bundle.pendingApproval.id,
              requestId: bundle.pendingApproval.requestId,
              planId: bundle.pendingApproval.planId,
              siteId: bundle.pendingApproval.siteId,
              status: bundle.pendingApproval.status,
              ...(bundle.pendingApproval.expiresAt !== undefined
                ? { expiresAt: bundle.pendingApproval.expiresAt }
                : {})
            },
      lastExecution:
        bundle.lastExecution === null
          ? null
          : {
              id: bundle.lastExecution.id,
              status: bundle.lastExecution.status,
              idempotencyKey: bundle.lastExecution.idempotencyKey,
              ...(bundle.lastExecution.completedAt !== undefined
                ? { completedAt: bundle.lastExecution.completedAt }
                : {})
            }
    });
  });

  ipcMain.handle(ipcChannels.executePlanAction, async (_event, payload) => {
    const req = parseRequest(ipcChannels.executePlanAction, payload);
    const result = await executePlanAction({
      siteId: req.siteId as SiteId,
      requestId: req.requestId as RequestId,
      planId: req.planId as ActionPlanId,
      actionId: req.actionId as ActionId,
      dryRun: req.dryRun,
      ...(req.idempotencyKey !== undefined
        ? { idempotencyKey: req.idempotencyKey }
        : {})
    });
    if (!result.ok) {
      return parseResponse(ipcChannels.executePlanAction, result);
    }
    return parseResponse(ipcChannels.executePlanAction, {
      ok: true,
      dryRun: result.dryRun,
      mcpResult: result.mcpResult,
      ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
      ...(result.reused !== undefined ? { reused: result.reused } : {}),
      ...(result.toolName !== undefined ? { toolName: result.toolName } : {}),
      ...(result.executionRunId !== undefined
        ? { executionRunId: result.executionRunId }
        : {}),
      ...(result.toolInvocationId !== undefined
        ? { toolInvocationId: result.toolInvocationId }
        : {})
    });
  });

  ipcMain.handle(ipcChannels.settingsGetState, async (_event, payload) => {
    const req = parseRequest(ipcChannels.settingsGetState, payload);
    const result = await getSettingsState({
      ...(req.workspaceId !== undefined
        ? { workspaceId: req.workspaceId as WorkspaceId }
        : {}),
      ...(req.siteId !== undefined ? { siteId: req.siteId as SiteId } : {})
    });
    return parseResponse(ipcChannels.settingsGetState, result);
  });

  ipcMain.handle(
    ipcChannels.settingsSetProviderSecret,
    async (_event, payload) => {
      const req = parseRequest(ipcChannels.settingsSetProviderSecret, payload);
      const result = await setProviderSecret(req);
      return parseResponse(ipcChannels.settingsSetProviderSecret, result);
    }
  );

  ipcMain.handle(
    ipcChannels.settingsClearProviderSecret,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.settingsClearProviderSecret,
        payload
      );
      const result = await clearProviderSecret(req);
      return parseResponse(ipcChannels.settingsClearProviderSecret, result);
    }
  );

  ipcMain.handle(
    ipcChannels.settingsSetPlannerPreferences,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.settingsSetPlannerPreferences,
        payload
      );
      const result = await setPlannerPreferences({
        ...(req.workspaceId !== undefined
          ? { workspaceId: req.workspaceId as WorkspaceId }
          : {}),
        preferences: req.preferences
      });
      return parseResponse(ipcChannels.settingsSetPlannerPreferences, result);
    }
  );

  ipcMain.handle(
    ipcChannels.settingsClearSiteSigningSecret,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.settingsClearSiteSigningSecret,
        payload
      );
      const result = await clearSiteSigningSecret({
        siteId: req.siteId as SiteId
      });
      return parseResponse(ipcChannels.settingsClearSiteSigningSecret, result);
    }
  );

  ipcMain.handle(ipcChannels.getCompatibilityInfo, async (_event, payload) => {
    parseRequest(ipcChannels.getCompatibilityInfo, payload);
    return parseResponse(ipcChannels.getCompatibilityInfo, {
      ...getCompatibilityPayload({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown"
      })
    });
  });

  ipcMain.handle(ipcChannels.exportBuildSiteBundle, async (_event, payload) => {
    const req = parseRequest(ipcChannels.exportBuildSiteBundle, payload);
    const result = await buildSiteExportBundle(req.siteId as SiteId);
    return parseResponse(ipcChannels.exportBuildSiteBundle, result);
  });

  ipcMain.handle(ipcChannels.importApplySiteBundle, async (_event, payload) => {
    const req = parseRequest(ipcChannels.importApplySiteBundle, payload);
    const result = await applySiteImportBundle(req.bundleJson);
    return parseResponse(ipcChannels.importApplySiteBundle, result);
  });
}
