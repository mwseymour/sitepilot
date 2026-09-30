import type {
  ChatMessagePayload,
  ChatThreadPayload,
  SitePilotDesktopApi
} from "@sitepilot/contracts";

export type ThreadRow = ChatThreadPayload;
export type MessageRow = ChatMessagePayload;

export type RequestBundleOk = Extract<
  Awaited<ReturnType<SitePilotDesktopApi["getRequestBundle"]>>,
  { ok: true }
>;
export type ChatMode = "request" | "conversation";

export type GutenbergV2Operation =
  | "create_draft"
  | "replace_content"
  | "apply_operations"
  | "publish"
  | "unpublish";

export type ThreadTypeMeta = {
  label: string;
  description: string;
};

export type MessageFilter = "all" | "non_system" | "system_only";

export const THREAD_TITLE_PREVIEW_THRESHOLD = 72;
export const REQUEST_PROMPT_PREVIEW_THRESHOLD = 280;
