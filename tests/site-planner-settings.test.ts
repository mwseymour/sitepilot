import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SecureStorage } from "@sitepilot/services";

const secrets = new Map<string, string>();

const storage: SecureStorage = {
  async get(key) {
    return secrets.get(`${key.namespace}:${key.keyId}`);
  },
  async set(key, value) {
    secrets.set(`${key.namespace}:${key.keyId}`, value);
  },
  async delete(key) {
    secrets.delete(`${key.namespace}:${key.keyId}`);
  },
  async has(key) {
    return secrets.has(`${key.namespace}:${key.keyId}`);
  }
};

const site = {
  id: "site-1",
  workspaceId: "workspace-1",
  name: "Example",
  baseUrl: "https://example.com",
  environment: "production",
  activationStatus: "active",
  createdAt: "2026-04-20T09:00:00.000Z",
  updatedAt: "2026-04-20T09:00:00.000Z"
};

const db = {
  repositories: {
    sites: {
      getById: vi.fn(async (siteId: string) => (siteId === site.id ? site : null))
    }
  }
};

vi.mock("../apps/desktop/src/main/app-secure-storage.js", () => ({
  getSecureStorage: () => storage
}));

vi.mock("../apps/desktop/src/main/app-database.js", () => ({
  getDatabase: () => db
}));

describe("site planner settings", () => {
  beforeEach(() => {
    secrets.clear();
    db.repositories.sites.getById.mockClear();
  });

  it("defaults approval bypass to false in settings state", async () => {
    const { getSettingsState } = await import(
      "../apps/desktop/src/main/settings-service.js"
    );

    const result = await getSettingsState({ siteId: site.id });

    expect(result).toMatchObject({
      ok: true,
      sitePlannerSettings: { bypassApprovalRequests: false },
      siteHasSigningSecret: false,
      uiPreferences: {
        developerToolsEnabled: false,
        preserveOriginalImageUploads: false
      }
    });
  });

  it("persists and reloads the site approval bypass flag", async () => {
    const { getSettingsState, setSitePlannerSettings } = await import(
      "../apps/desktop/src/main/settings-service.js"
    );

    const saveResult = await setSitePlannerSettings({
      siteId: site.id,
      settings: { bypassApprovalRequests: true }
    });
    expect(saveResult).toEqual({ ok: true });

    const result = await getSettingsState({ siteId: site.id });

    expect(result).toMatchObject({
      ok: true,
      sitePlannerSettings: { bypassApprovalRequests: true }
    });
  });

  it("downgrades blocked approval to warnings when bypass is enabled", async () => {
    const { applyApprovalBypass } = await import(
      "../apps/desktop/src/main/plan-generation-service.js"
    );

    expect(
      applyApprovalBypass(
        {
          kind: "blocked_approval",
          messages: ["This plan must go through an approval gate before execution."]
        },
        true
      )
    ).toEqual({
      kind: "warnings",
      messages: ["Site settings bypassed the approval gate for this plan."]
    });
    expect(
      applyApprovalBypass(
        {
          kind: "blocked_approval",
          messages: ["This plan must go through an approval gate before execution."]
        },
        false
      )
    ).toEqual({
      kind: "blocked_approval",
      messages: ["This plan must go through an approval gate before execution."]
    });
  });

  it("marks bypassed approval plans as approved for execution", async () => {
    const { deriveRequestStatusAfterPlanning } = await import(
      "../apps/desktop/src/main/plan-generation-service.js"
    );

    expect(
      deriveRequestStatusAfterPlanning({
        currentStatus: "drafted",
        rawValidation: {
          kind: "blocked_approval",
          messages: ["This plan must go through an approval gate before execution."]
        },
        validation: {
          kind: "warnings",
          messages: ["Site settings bypassed the approval gate for this plan."]
        }
      })
    ).toBe("approved");
  });

  it("marks passing plans as approved for execution", async () => {
    const { deriveRequestStatusAfterPlanning } = await import(
      "../apps/desktop/src/main/plan-generation-service.js"
    );

    expect(
      deriveRequestStatusAfterPlanning({
        currentStatus: "drafted",
        rawValidation: {
          kind: "pass"
        },
        validation: {
          kind: "pass"
        }
      })
    ).toBe("approved");
  });
});
