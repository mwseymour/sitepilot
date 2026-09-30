import { execFileSync } from "node:child_process";

import { chromium } from "playwright";

import { registerSiteWithWordPress } from "../../packages/core/src/register-site.js";

import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_BASE_URL,
  E2E_REGISTRATION_CODE,
  E2E_WP_PATH
} from "./config.js";

type RegisterResult = Awaited<ReturnType<typeof registerSiteWithWordPress>>;

/**
 * Reads the current registration code from Settings → SitePilot as the
 * E2E admin. The code sits inside a closed "Show code" disclosure, which
 * textContent still reads.
 */
export async function discoverRegistrationCode(): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(`${E2E_BASE_URL}wp-login.php`, {
      waitUntil: "networkidle"
    });
    await page.locator("#user_login").fill(E2E_ADMIN_USERNAME);
    await page.locator("#user_pass").fill(E2E_ADMIN_PASSWORD);
    await page.locator("#wp-submit").click();
    await page.waitForURL(/wp-admin/, { timeout: 30_000 });
    await page.goto(
      `${E2E_BASE_URL}wp-admin/options-general.php?page=sitepilot`,
      { waitUntil: "networkidle" }
    );
    const code = (await page.locator("code").allTextContents())
      .map((value) => value.trim())
      .find((value) => /^[A-Za-z0-9]{16,}$/.test(value));
    if (!code) {
      throw new Error(
        "Could not discover the SitePilot registration code from wp-admin."
      );
    }
    return code;
  } finally {
    await browser.close();
  }
}

/**
 * The site's registration code right now. Each registration uses the code up
 * (plugin 0.2.0 and later), so every script reads a fresh one just before it
 * registers: through wp-cli when the site's WordPress path is set, otherwise
 * from wp-admin. The configured code is the last resort, for older plugins.
 */
export async function currentRegistrationCode(): Promise<string> {
  if (E2E_WP_PATH) {
    try {
      const code = execFileSync(
        "wp",
        ["option", "get", "sitepilot_registration_code"],
        {
          cwd: E2E_WP_PATH,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }
      ).trim();
      if (code.length > 0) return code;
    } catch {
      // Fall through to wp-admin.
    }
  }
  try {
    return await discoverRegistrationCode();
  } catch (error) {
    if (E2E_REGISTRATION_CODE.length > 0) return E2E_REGISTRATION_CODE;
    throw error;
  }
}

/** Registers the E2E site the way the desktop's Add Site page does. */
export async function registerE2ESite(
  siteName: string
): Promise<RegisterResult> {
  return registerSiteWithWordPress({
    baseUrl: E2E_BASE_URL,
    siteName,
    wordpressUsername: E2E_ADMIN_USERNAME,
    workspaceId: "workspace-1",
    environment: "development",
    registrationCode: await currentRegistrationCode()
  });
}
