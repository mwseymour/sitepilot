import {
  canResolveActionViaPostLookup,
  findNumericPostId
} from "@sitepilot/services/post-target-resolution";

export function actionUnavailableReason(
  actionType: string,
  input: Record<string, unknown>
): string {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  const isPostTargetedWrite =
    normalized === "update_post" ||
    normalized === "update_post_fields" ||
    normalized === "update_post_content" ||
    normalized === "edit_post_fields" ||
    normalized === "sitepilot_update_post_fields" ||
    normalized === "set_post_seo_meta" ||
    normalized === "sitepilot_set_post_seo_meta";

  if (isPostTargetedWrite && findNumericPostId(input) === undefined) {
    if (canResolveActionViaPostLookup(actionType, input)) {
      return "target will be resolved via lookup";
    }
    return "missing target post id";
  }

  return "no MCP tool mapping";
}

export function actionCanResolveViaLookup(
  actionType: string,
  input: Record<string, unknown>
): boolean {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  return (
    (normalized === "update_post" ||
      normalized === "update_post_fields" ||
      normalized === "update_post_content" ||
      normalized === "edit_post_fields" ||
      normalized === "sitepilot_update_post_fields" ||
      normalized === "set_post_seo_meta" ||
      normalized === "sitepilot_set_post_seo_meta") &&
    actionUnavailableReason(actionType, input) ===
      "target will be resolved via lookup"
  );
}

function actionCreatesDraftPost(actionType: string): boolean {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  return (
    normalized === "create_draft_post" ||
    normalized === "create_draft_content" ||
    normalized === "create_post_draft" ||
    normalized === "sitepilot_create_draft_post"
  );
}

export function actionCanResolveViaPlannedCreate(
  actionType: string,
  input: Record<string, unknown>,
  priorActions: Array<{ type: string }>
): boolean {
  const normalized = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  const isPostTargetedWrite =
    normalized === "update_post" ||
    normalized === "update_post_fields" ||
    normalized === "update_post_content" ||
    normalized === "edit_post_fields" ||
    normalized === "sitepilot_update_post_fields" ||
    normalized === "set_post_seo_meta" ||
    normalized === "sitepilot_set_post_seo_meta";

  if (!isPostTargetedWrite || findNumericPostId(input) !== undefined) {
    return false;
  }

  return (
    priorActions.filter((action) => actionCreatesDraftPost(action.type))
      .length === 1
  );
}

export function requestCanExecute(status: string): boolean {
  return (
    status === "approved" ||
    status === "partially_completed" ||
    status === "completed"
  );
}

export function requestExecutionControlsLocked(status: string): boolean {
  return status === "completed";
}
