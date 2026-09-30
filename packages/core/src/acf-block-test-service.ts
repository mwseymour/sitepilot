import type { TestAcfBlocksResponse } from "@sitepilot/contracts";
import type { SiteId } from "@sitepilot/domain";

import { createGutenbergV2DesktopRuntime } from "./gutenberg-v2-runtime-service.js";

/**
 * Runs the native save-and-reopen test for every ACF block on the site.
 * The plugin records each result; a block becomes authorable by v2 only
 * after it passes, and falls back to being kept untouched when its field
 * group or ACF version changes.
 */
export async function testAcfBlocksForSite(
  siteId: SiteId
): Promise<TestAcfBlocksResponse> {
  const created = await createGutenbergV2DesktopRuntime(siteId);
  if (!created.ok) return created;
  const { runtime } = created;
  try {
    if (!runtime.runBlockFixtures) {
      return {
        ok: false,
        code: "unsupported",
        message: "This SitePilot runtime cannot run block tests."
      };
    }
    const statuses = await runtime.runBlockFixtures();
    return {
      ok: true,
      results: statuses.map((status) => ({
        blockName: status.blockName,
        status: status.status,
        ...(status.message === undefined ? {} : { message: status.message }),
        ...(status.testedAt === undefined ? {} : { testedAt: status.testedAt })
      }))
    };
  } catch (error) {
    return {
      ok: false,
      code: "block_test_failed",
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message.slice(0, 1_000)
          : "The ACF block test could not run."
    };
  } finally {
    await runtime.close().catch(() => undefined);
  }
}
