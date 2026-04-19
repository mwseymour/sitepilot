import type { WorkspaceSummary } from "@sitepilot/domain";

export function makeWorkspaceSummary(
  overrides: Partial<WorkspaceSummary> = {}
): WorkspaceSummary {
  return {
    id: overrides.id ?? ("workspace-1" as WorkspaceSummary["id"]),
    name: overrides.name ?? "Default Workspace",
    slug: overrides.slug ?? "default-workspace"
  };
}
