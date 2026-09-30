// Read-only third-party block report on the MAMP site: the editor probe
// joined with the plugin's content scan. Nothing is written.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SiteId } from "@sitepilot/domain";
import { initializeDatabase } from "@sitepilot/repositories";

import { getDatabase } from "../../apps/desktop/src/main/app-database.js";
import { registerSiteWithWordPress } from "../../apps/desktop/src/main/register-site.js";
import {
  configureRuntimeContext,
  resetRuntimeContext
} from "../../apps/desktop/src/main/runtime-context.js";
import { testThirdPartyBlocksForSite } from "../../apps/desktop/src/main/third-party-block-test-service.js";

import {
  E2E_ADMIN_USERNAME,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL
} from "./config.js";
import { createFileSecureStorage } from "./file-secure-storage.js";
import { currentRegistrationCode } from "./registration.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EXACT_TEST_URL = "https://test.localhost:8890/";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  assert(
    E2E_BASE_URL === EXACT_TEST_URL,
    `Refusing third-party E2E against ${E2E_BASE_URL}. Expected exactly ${EXACT_TEST_URL}`
  );
  const artifactDirectory = join(
    E2E_ARTIFACTS_ROOT,
    `v2-third-party-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  mkdirSync(artifactDirectory, { recursive: true });
  const runtimeDir = mkdtempSync(join(tmpdir(), "sitepilot-v2-third-party-"));
  const secureStorage = createFileSecureStorage(join(runtimeDir, "secure-store"));
  const database = initializeDatabase({
    filePath: join(runtimeDir, "sitepilot.sqlite")
  });
  configureRuntimeContext({ userDataPath: runtimeDir, database, secureStorage });
  try {
    getDatabase();
    const registration = await registerSiteWithWordPress({
      baseUrl: E2E_BASE_URL,
      siteName: "SitePilot v2 Third-party E2E",
      wordpressUsername: E2E_ADMIN_USERNAME,
      workspaceId: "workspace-1",
      environment: "development",
      registrationCode: await currentRegistrationCode()
    });
    if (!("site" in registration)) {
      throw new Error(
        `Registration failed (${"code" in registration ? `${registration.code}: ${registration.message}` : "missing site"}).`
      );
    }
    const siteId = registration.site.id as SiteId;
    const site = await database.repositories.sites.getById(siteId);
    assert(site, "Registration did not persist the site.");
    await database.repositories.sites.save({
      ...site,
      activationStatus: "active",
      updatedAt: new Date().toISOString()
    });

    const started = Date.now();
    const result = await testThirdPartyBlocksForSite(siteId);
    writeFileSync(
      join(artifactDirectory, "report.json"),
      `${JSON.stringify(result, null, 2)}\n`
    );
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const { report } = result;
    const byName = new Map(report.blocks.map((block) => [block.name, block]));

    assert(report.scannedPosts > 0, "The content scan read no posts.");
    assert(
      report.blocks.every((block) => !block.name.startsWith("core/") && !block.name.startsWith("acf/")),
      "Core or ACF blocks leaked into the third-party report."
    );
    assert(
      report.blocks
        .filter((block) => block.placement !== "top_level")
        .every((block) => block.probe.outcome === "not_tested"),
      "A block that is not top level was probed."
    );
    const faq = byName.get("yoast/faq-block");
    assert(faq, "yoast/faq-block is missing from the report.");
    assert(
      faq.placement === "top_level" &&
        faq.rendering === "saved_markup" &&
        faq.probe.outcome === "builds_cleanly" &&
        faq.readiness === "needs_definition",
      `yoast/faq-block was not reported as a clean top-level block: ${JSON.stringify(faq)}`
    );
    assert(
      faq.settings.some((setting) => setting.name === "questions" && setting.type === "array"),
      "yoast/faq-block settings did not include questions."
    );
    const cart = byName.get("woocommerce/cart");
    assert(
      cart && cart.usage.posts >= 1 && cart.usage.examples.length >= 1,
      `woocommerce/cart usage was not found: ${JSON.stringify(cart?.usage)}`
    );
    const order = report.blocks.map((block) => block.readiness);
    assert(
      order.indexOf("inside_block") === -1 ||
        order.lastIndexOf("needs_definition") < order.indexOf("inside_block"),
      "Blocks worth supporting are not listed first."
    );

    const counts = report.blocks.reduce<Record<string, number>>((result, block) => {
      result[`${block.placement}/${block.probe.outcome}`] =
        (result[`${block.placement}/${block.probe.outcome}`] ?? 0) + 1;
      return result;
    }, {});
    console.log(
      JSON.stringify(
        {
          outcome: "succeeded",
          ms: Date.now() - started,
          blocks: report.blocks.length,
          scannedPosts: report.scannedPosts,
          probeTimedOut: report.probeTimedOut,
          counts,
          topLevel: report.blocks
            .filter((block) => block.placement === "top_level")
            .map(
              (block) =>
                `${block.name} ${block.rendering} ${block.probe.outcome}${block.probe.preview === "not_checked" ? "" : ` preview:${block.probe.preview}`} posts:${block.usage.posts}${block.probe.message ? ` — ${block.probe.message}` : ""}${block.probe.previewMessage ? ` — ${block.probe.previewMessage}` : ""}`
            ),
          artifacts: artifactDirectory
        },
        null,
        2
      )
    );
  } finally {
    resetRuntimeContext();
    database.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
