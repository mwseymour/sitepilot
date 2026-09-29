import type { SiteSummary } from "@sitepilot/contracts";

export function activationLabel(
  status: SiteSummary["activationStatus"]
): string {
  return status === "active"
    ? "Active"
    : status === "config_required"
      ? "Configuration required"
      : "Inactive";
}
