export const SERVICES_PACKAGE_NAME = "@sitepilot/services";

export {
  GutenbergV2ContentService,
  GutenbergV2ServiceError,
  InMemoryGutenbergV2ApprovalStore,
  createGutenbergV2ApprovalBinding
} from "./gutenberg-v2-content-service.js";
export type {
  GutenbergV2ApprovalStore,
  GutenbergV2ContentServiceDependencies,
  GutenbergV2MediaService,
  GutenbergV2ReviewArtifact,
  GutenbergV2WordPressTransport,
  GutenbergV2Worker,
  GutenbergV2WorkerCompileResult
} from "./gutenberg-v2-content-service.js";
export {
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal
} from "./gutenberg-v2-journal.js";
export {
  DurableGutenbergV2MediaService,
  FileGutenbergV2StagedAssetStore,
  StagedGutenbergV2PreviewMediaResolver,
  gutenbergV2MediaBindingId,
  hashGutenbergV2PreviewMediaManifest
} from "./gutenberg-v2-media.js";
export type {
  DurableGutenbergV2MediaServiceOptions,
  GutenbergV2MediaBindingTransport,
  GutenbergV2PreviewMediaResolver,
  GutenbergV2StagedAsset,
  GutenbergV2StagedAssetStore
} from "./gutenberg-v2-media.js";
export type {
  GutenbergV2ExecutionJournal,
  GutenbergV2JournalCompareAndSetInput,
  GutenbergV2JournalCreateResult
} from "./gutenberg-v2-journal.js";
export {
  canonicalGutenbergV2Json,
  hashGutenbergV2Bytes,
  hashGutenbergV2Content,
  hashGutenbergV2Value
} from "./gutenberg-v2-hashing.js";
export {
  buildLlmGutenbergV2Plan,
  GutenbergV2PlanGenerationError
} from "./gutenberg-v2-plan-generator.js";
export type {
  BuildLlmGutenbergV2PlanInput,
  BuildLlmGutenbergV2PlanResult,
  GutenbergV2PlanningModelClient,
  GutenbergV2PlanningTarget,
  GutenbergV2PlanRevision
} from "./gutenberg-v2-plan-generator.js";

export {
  fallbackMergedRequestPrompt,
  mergeRevisedRequestPrompt
} from "./request-revision-merge.js";
export { analyzeClarification } from "./clarification-engine.js";
export type { ClarificationAnalysis } from "./clarification-engine.js";
export { buildPlannerContext } from "./planner-context.js";
export type { BuildPlannerContextInput } from "./planner-context.js";
export { extractJsonObject } from "./json-extract.js";
export {
  buildLlmActionPlan,
  buildStubActionPlan
} from "./generate-action-plan.js";
export { actionToMcpToolCall } from "./mcp-action-map.js";
export type { McpToolCall } from "./mcp-action-map.js";
export {
  actionSupportsPostLookup,
  buildPostLookupArguments,
  canResolveActionViaPostLookup,
  findNumericPostId,
  resolvePostIdFromLookupResult
} from "./post-target-resolution.js";
export {
  enrichActionPlanWithPostLookupFromContext,
  inferPostLookupHintsFromCorpus
} from "./plan-post-lookup-enrichment.js";
export {
  requestNeedsVisualAnalysisReview,
  requestVisualAnalysisIsCurrent
} from "./request-visual-analysis.js";
export type {
  SecretKey,
  SecretNamespace,
  SecureStorage
} from "./secure-storage.js";
