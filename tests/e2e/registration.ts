import { chromium } from "playwright";

import { registerSiteWithWordPress } from "../../apps/desktop/src/main/register-site.js";

import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_BASE_URL,
  E2E_REGISTRATION_CODE
} from "./config.js";

type RegisterResult = Awaited<ReturnType<typeof registerSiteWithWordPress>>;

/**
 * Reads the current registration code from Settings → SitePilot as the
 * E2E admin. Used when the configured code is out of date.
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
 * Registers the E2E site the way the desktop's Add Site page does. Tries the
 * configured registration code first, then the one shown in wp-admin.
 */
export async function registerE2ESite(siteName: string): Promise<RegisterResult> {
  const request = {
    baseUrl: E2E_BASE_URL,
    siteName,
    wordpressUsername: E2E_ADMIN_USERNAME,
    workspaceId: "workspace-1",
    environment: "development" as const
  };
  const configuredAttempt = await registerSiteWithWordPress({
    ...request,
    registrationCode: E2E_REGISTRATION_CODE
  });
  if (
    configuredAttempt.ok ||
    configuredAttempt.code !== "register_rejected" ||
    !/invalid registration code/i.test(configuredAttempt.message)
  ) {
    return configuredAttempt;
  }
  return registerSiteWithWordPress({
    ...request,
    registrationCode: await discoverRegistrationCode()
  });
}
