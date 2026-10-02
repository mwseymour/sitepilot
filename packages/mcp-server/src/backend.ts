import type { ReadToolDefinition } from "@sitepilot/services/read-tool-registry";

/** Who called a tool, as far as the transport knows. */
export type McpCaller = {
  /** `clientInfo.name` from the MCP initialize request, when sent. */
  clientName?: string;
  /**
   * The signed-in person, on the hosted server. Without it the caller is the
   * desktop operator with request-only rights.
   */
  actor?: {
    userProfileId: string;
    appRole: string;
    siteRoles: string[];
  };
  /**
   * OAuth scopes the person allowed this client (read, request, review).
   * Without them, as with personal tokens, every tool is available.
   */
  scopes?: readonly string[];
};

export type McpResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

export type McpSite = {
  siteId: string;
  name: string;
  baseUrl: string;
};

/** What a request needs to change. Mirrors the desktop's target picker. */
export type McpRequestTarget =
  | { operation: "create_draft"; postType: "post" | "page" }
  | {
      operation: "edit" | "replace";
      postType: "post" | "page";
      postId: number;
    }
  | {
      operation: "publish" | "unpublish";
      postType: "post" | "page";
      postId: number;
    };

/**
 * The plain states every client shows. Only `completed` means the change was
 * written and verified on the site.
 */
export const MCP_REQUEST_STATES = [
  "preparing_preview",
  "needs_your_reply",
  "awaiting_approval",
  "approved",
  "applying",
  "completed",
  "rejected",
  "needs_attention"
] as const;
export type McpRequestState = (typeof MCP_REQUEST_STATES)[number];

export type McpThreadMessage = {
  from: "you" | "sitepilot";
  text: string;
  at: string;
};

export type McpRequestStatus = {
  requestId: string;
  siteId: string;
  title: string;
  state: McpRequestState;
  /** One or two plain sentences on where the request is. */
  summary: string;
  /** Set when SitePilot needs an answer before it can continue. */
  question?: string;
  target?: McpRequestTarget;
  changes?: {
    operation: string;
    title?: string;
    excerpt?: string;
    seo?: Array<{ label: string; value: string }>;
    featuredImage?: string;
    /** Categories and tags the post ends with, per changed taxonomy. */
    terms?: Array<{ label: string; value: string }>;
  };
  /** On the hosted server, each has a signed link that opens without signing in. */
  reviewArtifacts?: Array<{ id: string; kind: string; url?: string }>;
  result?: { postId?: number; editUrl?: string };
  /**
   * Why the request stopped, in sitepilot.error/v1 terms. When `retryable` is
   * false, sending the same thing again won't help; revise the request.
   */
  failure?: { code: string; cause: string; retryable: boolean; message: string };
  /** Where a person approves the change. */
  approvalHint?: string;
  recentMessages: McpThreadMessage[];
  updatedAt: string;
};

export type McpThreadSummary = {
  threadId: string;
  kind: "request" | "conversation";
  title: string;
  source?: string;
  state?: McpRequestState;
  updatedAt: string;
};

export type McpReviewArtifact = {
  id: string;
  kind: "preview" | "structure_diff";
  mimeType: string;
  dataBase64: string;
  /** On the hosted server: a signed link that opens without signing in. */
  url?: string;
};

/**
 * The SitePilot operations the MCP tools call. The desktop app implements it
 * over its local services; the hosted backend will implement it over its own.
 * Nothing here approves, executes or publishes: a person does that in
 * SitePilot.
 */
export interface SitePilotMcpBackend {
  listSites(caller: McpCaller): Promise<McpSite[]>;
  lookup(
    input: {
      siteId: string;
      tool: ReadToolDefinition;
      args: Record<string, unknown>;
    },
    caller: McpCaller
  ): Promise<McpResult<{ result: unknown }>>;
  createConversation(
    input: { siteId: string; question: string; title?: string },
    caller: McpCaller
  ): Promise<McpResult<{ threadId: string; answer: string }>>;
  ask(
    input: { siteId: string; threadId: string; question: string },
    caller: McpCaller
  ): Promise<McpResult<{ threadId: string; answer: string }>>;
  createRequest(
    input: {
      siteId: string;
      text: string;
      target: McpRequestTarget;
      title?: string;
      /** Images or videos to use, from apps that carry files (Slack). */
      attachments?: McpAttachment[];
    },
    caller: McpCaller
  ): Promise<McpResult<{ status: McpRequestStatus }>>;
  addToRequest(
    input: { siteId: string; requestId: string; text: string; attachments?: McpAttachment[] },
    caller: McpCaller
  ): Promise<McpResult<{ status: McpRequestStatus }>>;
  requestStatus(
    input: { siteId: string; requestId: string },
    caller: McpCaller
  ): Promise<McpResult<{ status: McpRequestStatus }>>;
  listThreads(
    input: {
      siteId: string;
      kind?: "request" | "conversation";
      source?: string;
      limit: number;
    },
    caller: McpCaller
  ): Promise<McpResult<{ threads: McpThreadSummary[] }>>;
  getReviewArtifact(
    input: { siteId: string; requestId: string; artifactId: string },
    caller: McpCaller
  ): Promise<McpResult<{ artifact: McpReviewArtifact }>>;
  /** Called after every tool call, for the audit trail. */
  recordToolCall?(
    input: { tool: string; siteId?: string; ok: boolean; code?: string },
    caller: McpCaller
  ): Promise<void>;
  /**
   * Approving from a chat app (hosted only). The preview a person is asked
   * about: the request's current candidate, waiting for approval.
   */
  approvalSubject?(
    input: { siteId: string; requestId: string },
    caller: McpCaller
  ): Promise<McpResult<{ candidateId: string; status: McpRequestStatus }>>;
  /**
   * The person's own decision, given in a prompt the chat app showed them or
   * on the review card, never by the model. Approving applies the change.
   */
  decideForPerson?(
    input: {
      siteId: string;
      requestId: string;
      candidateId: string;
      decision: "approve" | "reject";
      note?: string;
      channel: McpApprovalChannel;
    },
    caller: McpCaller
  ): Promise<McpResult<{ status: McpRequestStatus }>>;
}

/** An image or video for a request, as the desktop composer sends one. */
export type McpAttachment = {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  dataUrl: string;
};

/** Where the person gave their decision, for the audit trail. */
export type McpApprovalChannel = "approval_prompt" | "review_card" | "slack_button";
