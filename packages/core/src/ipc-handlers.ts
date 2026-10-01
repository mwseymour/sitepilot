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

/**
 * Where the shared handlers run: Electron's ipcMain in the desktop app, the
 * hosted server's /api/ipc/:channel. Each host adds its own extras.
 */
export type IpcHost = {
  handle(
    channel: IpcChannel,
    handler: (payload: unknown) => unknown
  ): void;
  appVersion: string;
  electronVersion?: string;
  /** A folder picker; only the desktop has one. */
  chooseDirectory?: () => Promise<string | null>;
};

/** The desktop app's IPC API, for any host. */
export function registerSharedIpcHandlers(host: IpcHost): void {
  host.handle(ipcChannels.getShellInfo, (payload) => {
    parseRequest(ipcChannels.getShellInfo, payload);

    return parseResponse(ipcChannels.getShellInfo, {
      appName: "SitePilot",
      appVersion: host.appVersion,
      rendererVersion: "0.1.0"
    });
  });

  host.handle(ipcChannels.listWorkspaces, async (payload) => {
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

  host.handle(ipcChannels.listSites, async (payload) => {
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

  host.handle(ipcChannels.runSiteDiagnostics, async (payload) => {
    const request = parseRequest(ipcChannels.runSiteDiagnostics, payload);
    const result = await runConnectivityDiagnostics(request.siteId);
    return parseResponse(ipcChannels.runSiteDiagnostics, result);
  });

  host.handle(ipcChannels.refreshSiteDiscovery, async (payload) => {
    const request = parseRequest(ipcChannels.refreshSiteDiscovery, payload);
    const result = await refreshDiscoveryForSite(request.siteId);
    return parseResponse(ipcChannels.refreshSiteDiscovery, result);
  });

  host.handle(ipcChannels.testAcfBlocks, async (payload) => {
    const request = parseRequest(ipcChannels.testAcfBlocks, payload);
    const result = await testAcfBlocksForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.testAcfBlocks, result);
  });

  host.handle(ipcChannels.testThirdPartyBlocks, async (payload) => {
    const request = parseRequest(ipcChannels.testThirdPartyBlocks, payload);
    const result = await testThirdPartyBlocksForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.testThirdPartyBlocks, result);
  });

  host.handle(
    ipcChannels.generateSiteConfigDraft,
    async (payload) => {
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

  host.handle(ipcChannels.getSiteWorkspace, async (payload) => {
    const request = parseRequest(ipcChannels.getSiteWorkspace, payload);
    const result = await getSiteWorkspaceState(request.siteId as SiteId);
    return parseResponse(ipcChannels.getSiteWorkspace, result);
  });

  host.handle(ipcChannels.saveSiteConfig, async (payload) => {
    const request = parseRequest(ipcChannels.saveSiteConfig, payload);
    const result = await saveSiteConfigDocument(
      request.siteId as SiteId,
      request.siteConfig
    );
    return parseResponse(ipcChannels.saveSiteConfig, result);
  });

  host.handle(ipcChannels.confirmSiteConfig, async (payload) => {
    const request = parseRequest(ipcChannels.confirmSiteConfig, payload);
    const result = await confirmSiteConfigActivation(
      request.siteId as SiteId,
      request.configId as SiteConfigId
    );
    return parseResponse(ipcChannels.confirmSiteConfig, result);
  });

  host.handle(ipcChannels.listChatThreads, async (payload) => {
    const request = parseRequest(ipcChannels.listChatThreads, payload);
    const result = await listChatThreadsForSite(request.siteId as SiteId);
    return parseResponse(ipcChannels.listChatThreads, result);
  });

  host.handle(ipcChannels.createChatThread, async (payload) => {
    const request = parseRequest(ipcChannels.createChatThread, payload);
    const result = await createChatThreadForSite(request.siteId as SiteId, {
      title: request.title,
      ...(request.type !== undefined ? { type: request.type } : {})
    });
    return parseResponse(ipcChannels.createChatThread, result);
  });

  host.handle(ipcChannels.renameChatThread, async (payload) => {
    const request = parseRequest(ipcChannels.renameChatThread, payload);
    const result = await renameChatThreadForSite(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.title
    );
    return parseResponse(ipcChannels.renameChatThread, result);
  });

  host.handle(ipcChannels.deleteChatThread, async (payload) => {
    const request = parseRequest(ipcChannels.deleteChatThread, payload);
    const result = await deleteChatThreadForSite(
      request.siteId as SiteId,
      request.threadId as ChatThreadId
    );
    return parseResponse(ipcChannels.deleteChatThread, result);
  });

  host.handle(ipcChannels.listChatMessages, async (payload) => {
    const request = parseRequest(ipcChannels.listChatMessages, payload);
    const result = await listChatMessagesForThread(
      request.siteId as SiteId,
      request.threadId as ChatThreadId
    );
    return parseResponse(ipcChannels.listChatMessages, result);
  });

  host.handle(ipcChannels.postChatMessage, async (payload) => {
    const request = parseRequest(ipcChannels.postChatMessage, payload);
    const result = await postChatMessage(
      request.siteId as SiteId,
      request.threadId as ChatThreadId,
      request.text,
      request.attachments
    );
    return parseResponse(ipcChannels.postChatMessage, result);
  });

  host.handle(
    ipcChannels.appendSystemChatMessage,
    async (payload) => {
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

  host.handle(ipcChannels.createChatRequest, async (payload) => {
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

  host.handle(ipcChannels.amendRequest, async (payload) => {
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

  host.handle(ipcChannels.ingestThreadMessage, async (payload) => {
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

  host.handle(ipcChannels.answerClarification, async (payload) => {
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

  host.handle(ipcChannels.listAuditEntries, async (payload) => {
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

  host.handle(ipcChannels.registerSite, async (payload) => {
    const request = parseRequest(ipcChannels.registerSite, payload);
    const forward: Parameters<typeof registerSiteWithWordPress>[0] = {
      baseUrl: request.baseUrl,
      registrationCode: request.registrationCode,
      siteName: request.siteName,
      wordpressUsername: request.wordpressUsername
    };
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

  host.handle(ipcChannels.getProviderStatus, async (payload) => {
    parseRequest(ipcChannels.getProviderStatus, payload);
    const status = await readProviderStatus();
    return parseResponse(ipcChannels.getProviderStatus, status);
  });

  host.handle(ipcChannels.getRequestBundle, async (payload) => {
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

  host.handle(
    ipcChannels.gutenbergV2GenerateCandidate,
    async (payload) => {
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

  host.handle(
    ipcChannels.gutenbergV2DecideCandidate,
    async (payload) => {
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

  host.handle(
    ipcChannels.gutenbergV2ExecuteCandidate,
    async (payload) => {
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

  host.handle(
    ipcChannels.gutenbergV2GetExecutionProgress,
    async (payload) => {
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

  host.handle(ipcChannels.getSiteActivitySummary, async (payload) => {
    const req = parseRequest(ipcChannels.getSiteActivitySummary, payload);
    const result = await getSiteActivitySummary({
      siteId: req.siteId as SiteId,
      ...(req.limit === undefined ? {} : { limit: req.limit })
    });
    return parseResponse(ipcChannels.getSiteActivitySummary, result);
  });

  host.handle(ipcChannels.searchSiteContent, async (payload) => {
    const req = parseRequest(ipcChannels.searchSiteContent, payload);
    const result = await searchSiteContent({
      siteId: req.siteId as SiteId,
      query: req.query
    });
    return parseResponse(ipcChannels.searchSiteContent, result);
  });

  host.handle(
    ipcChannels.gutenbergV2GetRequestState,
    async (payload) => {
      const req = parseRequest(ipcChannels.gutenbergV2GetRequestState, payload);
      const result = await getGutenbergV2RequestState({
        siteId: req.siteId as SiteId,
        requestId: req.requestId as RequestId
      });
      return parseResponse(ipcChannels.gutenbergV2GetRequestState, result);
    }
  );

  host.handle(
    ipcChannels.gutenbergV2ListPendingCandidates,
    async (payload) => {
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

  host.handle(
    ipcChannels.gutenbergV2GetReviewArtifact,
    async (payload) => {
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

  host.handle(ipcChannels.settingsGetState, async (payload) => {
    const req = parseRequest(ipcChannels.settingsGetState, payload);
    const result = await getSettingsState({
      ...(req.workspaceId !== undefined
        ? { workspaceId: req.workspaceId as WorkspaceId }
        : {}),
      ...(req.siteId !== undefined ? { siteId: req.siteId as SiteId } : {})
    });
    return parseResponse(ipcChannels.settingsGetState, result);
  });

  host.handle(
    ipcChannels.settingsSetProviderSecret,
    async (payload) => {
      const req = parseRequest(ipcChannels.settingsSetProviderSecret, payload);
      const result = await setProviderSecret(req);
      return parseResponse(ipcChannels.settingsSetProviderSecret, result);
    }
  );

  host.handle(
    ipcChannels.settingsClearProviderSecret,
    async (payload) => {
      const req = parseRequest(
        ipcChannels.settingsClearProviderSecret,
        payload
      );
      const result = await clearProviderSecret(req);
      return parseResponse(ipcChannels.settingsClearProviderSecret, result);
    }
  );

  host.handle(
    ipcChannels.settingsSetPlannerPreferences,
    async (payload) => {
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


  host.handle(
    ipcChannels.settingsSetUiPreferences,
    async (payload) => {
      const req = parseRequest(ipcChannels.settingsSetUiPreferences, payload);
      const result = await setUiPreferences({
        preferences: req.preferences
      });
      return parseResponse(ipcChannels.settingsSetUiPreferences, result);
    }
  );

  host.handle(
    ipcChannels.settingsClearSiteSigningSecret,
    async (payload) => {
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

  host.handle(
    ipcChannels.settingsReindexCoreBlocks,
    async (payload) => {
      parseRequest(ipcChannels.settingsReindexCoreBlocks, payload);
      const result = await reindexCoreBlocks();
      return parseResponse(ipcChannels.settingsReindexCoreBlocks, result);
    }
  );

  host.handle(
    ipcChannels.settingsSetWordPressCoreSourcePath,
    async (payload) => {
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

  if (host.chooseDirectory) {
    const chooseDirectory = host.chooseDirectory;
    host.handle(
      ipcChannels.settingsChooseWordPressCoreSourcePath,
      async (payload) => {
        parseRequest(ipcChannels.settingsChooseWordPressCoreSourcePath, payload);
        const chosen = await chooseDirectory();
        if (chosen === null) {
          return parseResponse(
            ipcChannels.settingsChooseWordPressCoreSourcePath,
            {
              ok: true,
              path: null
            }
          );
        }
        const saveResult = await setWordPressCoreSourcePath({ path: chosen });
        return parseResponse(
          ipcChannels.settingsChooseWordPressCoreSourcePath,
          saveResult
        );
      }
    );
  }

  host.handle(ipcChannels.getCompatibilityInfo, async (payload) => {
    parseRequest(ipcChannels.getCompatibilityInfo, payload);
    return parseResponse(ipcChannels.getCompatibilityInfo, {
      ...getCompatibilityPayload({
        appVersion: host.appVersion,
        electronVersion: host.electronVersion ?? "none"
      })
    });
  });

  host.handle(ipcChannels.exportBuildSiteBundle, async (payload) => {
    const req = parseRequest(ipcChannels.exportBuildSiteBundle, payload);
    const result = await buildSiteExportBundle(req.siteId as SiteId);
    return parseResponse(ipcChannels.exportBuildSiteBundle, result);
  });

  host.handle(ipcChannels.importApplySiteBundle, async (payload) => {
    const req = parseRequest(ipcChannels.importApplySiteBundle, payload);
    const result = await applySiteImportBundle(req.bundleJson);
    return parseResponse(ipcChannels.importApplySiteBundle, result);
  });
}
