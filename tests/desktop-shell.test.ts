import type { WorkspaceSummary } from "@sitepilot/contracts";
import { describe, expect, it } from "vitest";

import { createMainWindowOptions } from "../apps/desktop/src/main/window-config.js";
import { makeWorkspaceSummary } from "../packages/test-utils/src/index.js";

describe("desktop shell scaffolding", () => {
  it("resolves shared workspace types through the monorepo", () => {
    const workspace: WorkspaceSummary = makeWorkspaceSummary({
      name: "Agency Workspace"
    });

    expect(workspace.name).toBe("Agency Workspace");
  });

  it("keeps renderer privileges disabled in the BrowserWindow config", () => {
    const options = createMainWindowOptions();

    expect(options.title).toBe("SitePilot");
    expect(options.webPreferences.contextIsolation).toBe(true);
    expect(options.webPreferences.nodeIntegration).toBe(false);
    expect(options.webPreferences.sandbox).toBe(true);
    expect(options.webPreferences.preload).toContain("preload/index.js");
  });
});
