/**
 * Site onboarding end to end, the way the desktop does it:
 *
 * 1. Registers the MAMP site (Add Site).
 * 2. Runs discovery (Diagnostics → Refresh discovery).
 * 3. Generates and confirms the site config (Config), which activates the site.
 * 4. Runs the connectivity diagnostics and checks the plugin's /protocol report.
 *
 * Makes no content changes. Needs the MAMP site at https://test.localhost:8890/.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SiteConfigId, SiteId } from "@sitepilot/domain";
import { initializeDatabase } from "@sitepilot/repositories";

import { getDatabase } from "../../apps/desktop/src/main/app-database.js";
import { runConnectivityDiagnostics } from "../../apps/desktop/src/main/connectivity-diagnostics.js";
import { refreshDiscoveryForSite } from "../../apps/desktop/src/main/discovery-service.js";
import { configureRuntimeContext } from "../../apps/desktop/src/main/runtime-context.js";
import { generateAndPersistSiteConfigDraft } from "../../apps/desktop/src/main/site-config-draft.js";
import { fetchSiteUrl } from "../../apps/desktop/src/main/site-fetch.js";
import { confirmSiteConfigActivation } from "../../apps/desktop/src/main/site-workspace-service.js";

import { registerSiteWithWordPress } from "../../apps/desktop/src/main/register-site.js";

import { E2E_ADMIN_USERNAME, E2E_BASE_URL } from "./config.js";
import { createFileSecureStorage } from "./file-secure-storage.js";
import { currentRegistrationCode } from "./registration.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EXACT_TEST_URL = "https://test.localhost:8890/";
const REQUIRED_TOOLS = [
  "sitepilot-find-posts",
  "sitepilot-get-post",
  "sitepilot-site-discovery"
];
// The v1 write abilities were removed in plugin 0.2.0. Content changes only go
// through the signed v2 routes.
const REMOVED_WRITE_TOOLS = [
  "sitepilot-create-draft-post",
  "sitepilot-update-post-fields",
  "sitepilot-set-post-seo-meta",
  "sitepilot-set-post-featured-image",
  "sitepilot-upload-media-asset"
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  assert(
    E2E_BASE_URL === EXACT_TEST_URL,
    `Refusing onboarding E2E against ${E2E_BASE_URL}. Expected exactly ${EXACT_TEST_URL}`
  );
  const runtimeDir = mkdtempSync(
    join(tmpdir(), "sitepilot-v2-onboarding-e2e-")
  );
  const database = initializeDatabase({
    filePath: join(runtimeDir, "sitepilot.sqlite")
  });
  configureRuntimeContext({
    userDataPath: runtimeDir,
    database,
    secureStorage: createFileSecureStorage(join(runtimeDir, "secure-store"))
  });

  try {
    // Seed the normal desktop workspace before registration writes its site rows.
    getDatabase();

    const register = (registrationCode: string) =>
      registerSiteWithWordPress({
        baseUrl: E2E_BASE_URL,
        siteName: "SitePilot onboarding E2E",
        wordpressUsername: E2E_ADMIN_USERNAME,
        workspaceId: "workspace-1",
        environment: "development",
        registrationCode
      });
    const codeBefore = await currentRegistrationCode();
    const registration = await register(codeBefore);
    if (!registration.ok) {
      throw new Error(
        `Registration failed (${registration.code}): ${registration.message}`
      );
    }
    // Hardening T1: each code works once.
    const codeAfter = await currentRegistrationCode();
    assert(
      codeAfter !== codeBefore,
      "Registering did not replace the registration code."
    );
    const reused = await register(codeBefore);
    assert(
      !reused.ok && /invalid registration code/i.test(reused.message),
      `A used registration code registered another client: ${JSON.stringify(reused)}`
    );
    const siteId = registration.site.id as SiteId;
    const registered = await database.repositories.sites.getById(siteId);
    assert(registered, "Registration did not persist the site.");
    assert(
      registered.activationStatus !== "active",
      "A newly registered site should not be active before its config is confirmed."
    );

    const discovery = await refreshDiscoveryForSite(siteId);
    if (!discovery.ok) {
      throw new Error(
        `Discovery failed (${discovery.code}): ${discovery.message}`
      );
    }
    const discovered = discovery.snapshot.summary["discovery"] as
      | { post_types?: Record<string, unknown> }
      | undefined;
    const postTypes = Object.keys(discovered?.post_types ?? {});
    assert(
      postTypes.includes("post") && postTypes.includes("page"),
      `Discovery did not report posts and pages: ${postTypes.join(", ")}`
    );

    const draft = await generateAndPersistSiteConfigDraft(siteId);
    if (!draft.ok) {
      throw new Error(`Config draft failed (${draft.code}): ${draft.message}`);
    }
    const activation = await confirmSiteConfigActivation(
      siteId,
      draft.siteConfig.id as SiteConfigId
    );
    if (!activation.ok) {
      throw new Error(
        `Activation failed (${activation.code}): ${activation.message}`
      );
    }
    const activated = await database.repositories.sites.getById(siteId);
    assert(
      activated?.activationStatus === "active",
      "Confirming the config did not activate the site."
    );

    const diagnostics = await runConnectivityDiagnostics(siteId);
    assert(
      diagnostics.overallOk,
      `Connectivity diagnostics failed: ${JSON.stringify(diagnostics.checks)}`
    );
    const toolNames = diagnostics.checks.mcpTools.toolNames;
    const missingTools = REQUIRED_TOOLS.filter(
      (name) => !toolNames.includes(name)
    );
    assert(
      missingTools.length === 0,
      `The plugin MCP server is missing ${missingTools.join(", ")}. It listed: ${toolNames.join(", ")}`
    );

    const exposedWriteTools = REMOVED_WRITE_TOOLS.filter((name) =>
      toolNames.includes(name)
    );
    assert(
      exposedWriteTools.length === 0,
      `The plugin MCP server still exposes v1 write tools: ${exposedWriteTools.join(", ")}. Is the site's plugin copy up to date?`
    );

    // Hardening T8: the plugin MCP route only accepts SitePilot-signed requests.
    const unsigned = await fetchSiteUrl(
      `${E2E_BASE_URL}wp-json/sitepilot/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      }
    );
    assert(
      unsigned.status === 401 || unsigned.status === 403,
      `An unsigned MCP request got HTTP ${unsigned.status}.`
    );

    const protocolResponse = await fetchSiteUrl(
      `${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`
    );
    const protocol = (await protocolResponse.json()) as {
      mcp?: { registered?: boolean | null; issue?: string | null };
      v2?: { enabled?: boolean };
    };
    assert(
      protocol.v2?.enabled === true,
      "The plugin reports that v2 is disabled."
    );
    assert(
      protocol.mcp?.registered === true,
      `The plugin reports its MCP server is not registered (${protocol.mcp?.issue ?? "no issue given"}).`
    );

    console.log("v2 onboarding E2E passed.");
    console.log(
      JSON.stringify(
        {
          siteId,
          postTypes,
          toolNames,
          diagnostics: diagnostics.checks.protocolMetadata
        },
        null,
        2
      )
    );
  } finally {
    database.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
