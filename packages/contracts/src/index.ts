import type { WorkspaceSummary } from "@sitepilot/domain";

export type { WorkspaceSummary } from "@sitepilot/domain";

export interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}
