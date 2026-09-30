import { app, dialog, ipcMain } from "electron";

import {
  ipcChannels,
  ipcContracts,
  requestSchema,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse
} from "@sitepilot/contracts";
import type {
  ActionId,
  ChatThreadId,
  Request,
  RequestId,
  SiteConfigId,
  SiteId,
  Workspace,
  WorkspaceId
} from "@sitepilot/domain";

import { listAuditEntriesForSite } from "./audit-query-service.js";
import {
  amendRequestForThread,
  appendSystemChatMessage,
  answerClarificationForRequest,
  createChatThreadForSite,
  createTypedRequestForThread,
  deleteChatThreadForSite,
  listChatMessagesForThread,
  listChatThreadsForSite,
  postChatMessage,
  renameChatThreadForSite
} from "./chat-service.js";
import { runConnectivityDiagnostics } from "./connectivity-diagnostics.js";
import { getDatabase } from "./app-database.js";
import { refreshDiscoveryForSite } from "./discovery-service.js";
import { testAcfBlocksForSite } from "./acf-block-test-service.js";
import { testThirdPartyBlocksForSite } from "./third-party-block-test-service.js";
import { generateAndPersistSiteConfigDraft } from "./site-config-draft.js";
import {
  confirmSiteConfigActivation,
  getSiteWorkspaceState,
  saveSiteConfigDocument
} from "./site-workspace-service.js";
import { readProviderStatus } from "./provider-status-service.js";
import { registerSiteWithWordPress } from "./register-site.js";
import { getRequestBundleForThread } from "./request-bundle-service.js";
import {
  getGutenbergV2ExecutionProgress,
  getSiteActivitySummary,
  searchSiteContent
} from "./site-activity-service.js";
import { ingestRequestThreadMessage } from "./request-ingress-service.js";
import { getCompatibilityPayload } from "./compatibility-info.js";
import { buildSiteExportBundle } from "./export-site-service.js";
import { applySiteImportBundle } from "./import-site-service.js";
import {
  getMcpServerState,
  regenerateMcpServerToken,
  saveMcpServerSettings
} from "./mcp-server-service.js";
import {
  clearProviderSecret,
  clearSiteSigningSecret,
  getSettingsState,
  reindexCoreBlocks,
  setWordPressCoreSourcePath,
  setPlannerPreferences,
  setUiPreferences,
  setProviderSecret
} from "./settings-service.js";
import {
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  generateGutenbergV2Candidate,
  getGutenbergV2RequestState,
  getGutenbergV2ReviewArtifact,
  listGutenbergV2PendingCandidates
} from "./gutenberg-v2-chat-service.js";

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
    ...(entity.attachments !== undefined
      ? { attachments: entity.attachments }
      : {}),
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

  ipcMain.handle(ipcChannels.testAcfBlocks, async (_event, payload) => {
    const request = parseRequest(ipcChannels.testAcfBlocks, payload);
    const result = await testAcfBlocksForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.testAcfBlocks, result);
  });

  ipcMain.handle(ipcChannels.testThirdPartyBlocks, async (_event, payload) => {
    const request = parseRequest(ipcChannels.testThirdPartyBlocks, payload);
    const result = await testThirdPartyBlocksForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.testThirdPartyBlocks, result);
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

  ipcMain.handle(ipcChannels.renameChatThread, async (_event, payload) => {
    const request = parseRequest(ipcChannels.renameChatThread, payload);
    const result = await renameChatThreadForSite(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.title
    );
    return parseResponse(ipcChannels.renameChatThread, result);
  });

  ipcMain.handle(ipcChannels.deleteChatThread, async (_event, payload) => {
    const request = parseRequest(ipcChannels.deleteChatThread, payload);
    const result = await deleteChatThreadForSite(
      request.siteId as SiteId,
      request.threadId as ChatThreadId
    );
    return parseResponse(ipcChannels.deleteChatThread, result);
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
      request.text,
      request.attachments
    );
    return parseResponse(ipcChannels.postChatMessage, result);
  });

  ipcMain.handle(
    ipcChannels.appendSystemChatMessage,
    async (_event, payload) => {
      const request = parseRequest(
        ipcChannels.appendSystemChatMessage,
        payload
      );
      const result = await appendSystemChatMessage(
        request.siteId as SiteId,
        request.threadId as ChatThreadId,
        request.text,
        request.requestId as RequestId | undefined
      );
      return parseResponse(ipcChannels.appendSystemChatMessage, result);
    }
  );

  ipcMain.handle(ipcChannels.createChatRequest, async (_event, payload) => {
    const request = parseRequest(ipcChannels.createChatRequest, payload);
    const result = await createTypedRequestForThread(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.userPrompt,
      request.attachments
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
      request.text,
      request.attachments
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

  ipcMain.handle(ipcChannels.ingestThreadMessage, async (_event, payload) => {
    const request = parseRequest(ipcChannels.ingestThreadMessage, payload);
    const result = await ingestRequestThreadMessage({
      siteId: request.siteId as SiteId,
      threadId: request.threadId as ChatThreadId,
      text: request.text,
      ...(request.attachments !== undefined
        ? { attachments: request.attachments }
        : {}),
      ...(request.gutenbergV2Target !== undefined
        ? { gutenbergV2Target: request.gutenbergV2Target }
        : {})
    });
    if (!result.ok) {
      return parseResponse(ipcChannels.ingestThreadMessage, {
        ok: false,
        code: result.code,
        message: result.message,
        ...(result.request !== undefined
          ? { request: contractRequestPayload(result.request) }
          : {})
      });
    }
    return parseResponse(ipcChannels.ingestThreadMessage, {
      ok: true,
      outcome: result.outcome,
      continued: result.continued,
      ...(result.request !== undefined
        ? { request: contractRequestPayload(result.request) }
        : {}),
      ...(result.clarificationRound !== undefined
        ? { clarificationRound: result.clarificationRound }
        : {}),
      ...(result.gutenbergV2State !== undefined
        ? { gutenbergV2State: result.gutenbergV2State }
        : {}),
    });
  });

  ipcMain.handle(ipcChannels.answerClarification, async (_event, payload) => {
    const request = parseRequest(ipcChannels.answerClarification, payload);
    const result = await answerClarificationForRequest(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.requestId as RequestId,
      request.answer,
      request.attachments
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
      legacyV1: bundle.legacyV1
    });
  });

  ipcMain.handle(
    ipcChannels.gutenbergV2GenerateCandidate,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.gutenbergV2GenerateCandidate,
        payload
      );
      const result = await generateGutenbergV2Candidate({
        siteId: req.siteId as SiteId,
        requestId: req.requestId as RequestId,
        target: req.target
      });
      return parseResponse(ipcChannels.gutenbergV2GenerateCandidate, result);
    }
  );

  ipcMain.handle(
    ipcChannels.gutenbergV2DecideCandidate,
    async (_event, payload) => {
      const req = parseRequest(ipcChannels.gutenbergV2DecideCandidate, payload);
      const result = await decideGutenbergV2Candidate({
        siteId: req.siteId as SiteId,
        requestId: req.requestId as RequestId,
        candidateId: req.candidateId,
        decision: req.decision,
        ...(req.note === undefined ? {} : { note: req.note })
      });
      return parseResponse(ipcChannels.gutenbergV2DecideCandidate, result);
    }
  );

  ipcMain.handle(
    ipcChannels.gutenbergV2ExecuteCandidate,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.gutenbergV2ExecuteCandidate,
        payload
      );
      const result = await executeGutenbergV2Candidate({
        siteId: req.siteId as SiteId,
        requestId: req.requestId as RequestId
      });
      return parseResponse(ipcChannels.gutenbergV2ExecuteCandidate, result);
    }
  );

  ipcMain.handle(
    ipcChannels.gutenbergV2GetExecutionProgress,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.gutenbergV2GetExecutionProgress,
        payload
      );
      const result = await getGutenbergV2ExecutionProgress({
        siteId: req.siteId as SiteId,
        requestId: req.requestId
      });
      return parseResponse(ipcChannels.gutenbergV2GetExecutionProgress, result);
    }
  );

  ipcMain.handle(ipcChannels.getSiteActivitySummary, async (_event, payload) => {
    const req = parseRequest(ipcChannels.getSiteActivitySummary, payload);
    const result = await getSiteActivitySummary({
      siteId: req.siteId as SiteId,
      ...(req.limit === undefined ? {} : { limit: req.limit })
    });
    return parseResponse(ipcChannels.getSiteActivitySummary, result);
  });

  ipcMain.handle(ipcChannels.searchSiteContent, async (_event, payload) => {
    const req = parseRequest(ipcChannels.searchSiteContent, payload);
    const result = await searchSiteContent({
      siteId: req.siteId as SiteId,
      query: req.query
    });
    return parseResponse(ipcChannels.searchSiteContent, result);
  });

  ipcMain.handle(
    ipcChannels.gutenbergV2GetRequestState,
    async (_event, payload) => {
      const req = parseRequest(ipcChannels.gutenbergV2GetRequestState, payload);
      const result = await getGutenbergV2RequestState({
        siteId: req.siteId as SiteId,
        requestId: req.requestId as RequestId
      });
      return parseResponse(ipcChannels.gutenbergV2GetRequestState, result);
    }
  );

  ipcMain.handle(
    ipcChannels.gutenbergV2ListPendingCandidates,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.gutenbergV2ListPendingCandidates,
        payload
      );
      const result = await listGutenbergV2PendingCandidates({
        siteId: req.siteId as SiteId
      });
      return parseResponse(
        ipcChannels.gutenbergV2ListPendingCandidates,
        result
      );
    }
  );

  ipcMain.handle(
    ipcChannels.gutenbergV2GetReviewArtifact,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.gutenbergV2GetReviewArtifact,
        payload
      );
      const result = await getGutenbergV2ReviewArtifact({
        siteId: req.siteId as SiteId,
        requestId: req.requestId as RequestId,
        artifactId: req.artifactId
      });
      return parseResponse(ipcChannels.gutenbergV2GetReviewArtifact, result);
    }
  );

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
    ipcChannels.settingsSetUiPreferences,
    async (_event, payload) => {
      const req = parseRequest(ipcChannels.settingsSetUiPreferences, payload);
      const result = await setUiPreferences({
        preferences: req.preferences
      });
      return parseResponse(ipcChannels.settingsSetUiPreferences, result);
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

  ipcMain.handle(
    ipcChannels.settingsReindexCoreBlocks,
    async (_event, payload) => {
      parseRequest(ipcChannels.settingsReindexCoreBlocks, payload);
      const result = await reindexCoreBlocks();
      return parseResponse(ipcChannels.settingsReindexCoreBlocks, result);
    }
  );

  ipcMain.handle(
    ipcChannels.settingsSetWordPressCoreSourcePath,
    async (_event, payload) => {
      const req = parseRequest(
        ipcChannels.settingsSetWordPressCoreSourcePath,
        payload
      );
      const result = await setWordPressCoreSourcePath({ path: req.path });
      return parseResponse(
        ipcChannels.settingsSetWordPressCoreSourcePath,
        result
      );
    }
  );

  ipcMain.handle(
    ipcChannels.settingsChooseWordPressCoreSourcePath,
    async (_event, payload) => {
      parseRequest(ipcChannels.settingsChooseWordPressCoreSourcePath, payload);
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose WordPress core folder"
      });
      if (result.canceled || result.filePaths.length === 0) {
        return parseResponse(
          ipcChannels.settingsChooseWordPressCoreSourcePath,
          {
            ok: true,
            path: null
          }
        );
      }
      const saveResult = await setWordPressCoreSourcePath({
        path: result.filePaths[0] ?? null
      });
      return parseResponse(
        ipcChannels.settingsChooseWordPressCoreSourcePath,
        saveResult
      );
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

  ipcMain.handle(ipcChannels.mcpServerGetState, async (_event, payload) => {
    parseRequest(ipcChannels.mcpServerGetState, payload);
    return parseResponse(ipcChannels.mcpServerGetState, {
      ok: true,
      state: await getMcpServerState()
    });
  });

  ipcMain.handle(ipcChannels.mcpServerSaveSettings, async (_event, payload) => {
    const req = parseRequest(ipcChannels.mcpServerSaveSettings, payload);
    return parseResponse(ipcChannels.mcpServerSaveSettings, {
      ok: true,
      state: await saveMcpServerSettings({
        enabled: req.enabled,
        port: req.port,
        siteScope: req.siteScope === "all" ? "all" : [...req.siteScope]
      })
    });
  });

  ipcMain.handle(
    ipcChannels.mcpServerRegenerateToken,
    async (_event, payload) => {
      parseRequest(ipcChannels.mcpServerRegenerateToken, payload);
      return parseResponse(ipcChannels.mcpServerRegenerateToken, {
        ok: true,
        state: await regenerateMcpServerToken()
      });
    }
  );
}
