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

describe("initial window size", () => {
  it("fills most of the screen within the minimum and maximum", async () => {
    const { resolveInitialWindowSize } = await import(
      "../apps/desktop/src/main/window-config.js"
    );

    expect(resolveInitialWindowSize({ width: 1512, height: 944 })).toEqual({
      width: 1436,
      height: 897
    });
    expect(resolveInitialWindowSize({ width: 3008, height: 1667 })).toEqual({
      width: 1920,
      height: 1200
    });
    expect(resolveInitialWindowSize({ width: 1000, height: 700 })).toEqual({
      width: 1000,
      height: 700
    });
  });
});
