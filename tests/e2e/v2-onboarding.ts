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

import type { SiteId } from "@sitepilot/domain";
import { initializeDatabase } from "@sitepilot/repositories";

import { getDatabase } from "../../apps/desktop/src/main/app-database.js";
import { runConnectivityDiagnostics } from "../../apps/desktop/src/main/connectivity-diagnostics.js";
import { refreshDiscoveryForSite } from "../../apps/desktop/src/main/discovery-service.js";
import { configureRuntimeContext } from "../../apps/desktop/src/main/runtime-context.js";
import { generateAndPersistSiteConfigDraft } from "../../apps/desktop/src/main/site-config-draft.js";
import { fetchSiteUrl } from "../../apps/desktop/src/main/site-fetch.js";
import { confirmSiteConfigActivation } from "../../apps/desktop/src/main/site-workspace-service.js";

import { E2E_BASE_URL } from "./config.js";
import { createFileSecureStorage } from "./file-secure-storage.js";
import { registerE2ESite } from "./registration.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EXACT_TEST_URL = "https://test.localhost:8890/";
const REQUIRED_TOOLS = ["sitepilot-find-posts", "sitepilot-get-post", "sitepilot-site-discovery"];

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
  const runtimeDir = mkdtempSync(join(tmpdir(), "sitepilot-v2-onboarding-e2e-"));
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

    const registration = await registerE2ESite("SitePilot onboarding E2E");
    if (!registration.ok) {
      throw new Error(`Registration failed (${registration.code}): ${registration.message}`);
    }
    const siteId = registration.site.id as SiteId;
    const registered = await database.repositories.sites.getById(siteId);
    assert(registered, "Registration did not persist the site.");
    assert(
      registered.activationStatus !== "active",
      "A newly registered site should not be active before its config is confirmed."
    );

    const discovery = await refreshDiscoveryForSite(siteId);
    if (!discovery.ok) {
      throw new Error(`Discovery failed (${discovery.code}): ${discovery.message}`);
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
    const activation = await confirmSiteConfigActivation(siteId, draft.siteConfig.id);
    if (!activation.ok) {
      throw new Error(`Activation failed (${activation.code}): ${activation.message}`);
    }
    const activated = await database.repositories.sites.getById(siteId);
    assert(activated?.activationStatus === "active", "Confirming the config did not activate the site.");

    const diagnostics = await runConnectivityDiagnostics(siteId);
    assert(
      diagnostics.overallOk,
      `Connectivity diagnostics failed: ${JSON.stringify(diagnostics.checks)}`
    );
    const toolNames = diagnostics.checks.mcpTools.toolNames;
    const missingTools = REQUIRED_TOOLS.filter((name) => !toolNames.includes(name));
    assert(
      missingTools.length === 0,
      `The plugin MCP server is missing ${missingTools.join(", ")}. It listed: ${toolNames.join(", ")}`
    );

    const protocolResponse = await fetchSiteUrl(`${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`);
    const protocol = (await protocolResponse.json()) as {
      mcp?: { registered?: boolean | null; issue?: string | null };
      v2?: { enabled?: boolean };
    };
    assert(protocol.v2?.enabled === true, "The plugin reports that v2 is disabled.");
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
