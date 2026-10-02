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
  SqlGutenbergV2ApprovalStore,
  SqlGutenbergV2ExecutionJournal,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal
} from "./gutenberg-v2-journal.js";
export {
  DurableGutenbergV2MediaService,
  FileGutenbergV2StagedAssetStore,
  StagedGutenbergV2PreviewMediaResolver,
  detectGutenbergV2MediaType,
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
  APPROVAL_PROOF_AUDIENCE,
  APPROVAL_STATEMENT_SCHEMA,
  approvalKeyId,
  approvalKeyRequest,
  approvalSigningKeyFromPem,
  generateApprovalSigningKey,
  gutenbergV2ApprovalStatement,
  signGutenbergV2Approval,
  verifyGutenbergV2ApprovalProof
} from "./gutenberg-v2-approval-proof.js";
export type { ApprovalSigningKey } from "./gutenberg-v2-approval-proof.js";
export {
  buildLlmGutenbergV2Plan,
  GutenbergV2PlanClarification,
  GutenbergV2PlanGenerationError,
  missingOperatorMediaQuestion
} from "./gutenberg-v2-plan-generator.js";
export type {
  BuildLlmGutenbergV2PlanInput,
  BuildLlmGutenbergV2PlanResult,
  GutenbergV2PlanningModelClient,
  GutenbergV2PlanningTarget,
  GutenbergV2PlanRevision,
  GutenbergV2ReferenceImage
} from "./gutenberg-v2-plan-generator.js";

export {
  fallbackMergedRequestPrompt,
  mergeRevisedRequestPrompt
} from "./request-revision-merge.js";
export { extractJsonObject } from "./json-extract.js";
export {
  isPublicAddress,
  safeFetch,
  SafeFetchError
} from "./safe-fetch.js";
export type {
  ResolvedAddress,
  SafeFetchErrorCode,
  SafeFetchOptions,
  SafeFetchResponse
} from "./safe-fetch.js";
export {
  actionSupportsPostLookup,
  buildPostLookupArguments,
  canResolveActionViaPostLookup,
  findNumericPostId,
  resolvePostIdFromLookupResult
} from "./post-target-resolution.js";
export type {
  SecretKey,
  SecretNamespace,
  SecureStorage
} from "./secure-storage.js";
export {
  EncryptedSqlSecureStorage,
  SECRETS_TABLE_SQL,
  parseSecretsKey
} from "./sql-secure-storage.js";
export {
  SqlStoredFileMirror,
  pruneStoredFiles,
  type StoredFileMirror
} from "./stored-file-mirror.js";
