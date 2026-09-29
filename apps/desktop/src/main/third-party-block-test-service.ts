import type { TestThirdPartyBlocksResponse } from "@sitepilot/contracts";
import type { SiteId } from "@sitepilot/domain";

import { createGutenbergV2DesktopRuntime } from "./gutenberg-v2-runtime-service.js";

/**
 * Read-only report of the site's third-party blocks: how each is placed,
 * whether the site's editor builds it cleanly, and how existing content uses
 * it. Nothing is saved; v2 keeps these blocks untouched either way.
 */
export async function testThirdPartyBlocksForSite(
  siteId: SiteId
): Promise<TestThirdPartyBlocksResponse> {
  const created = await createGutenbergV2DesktopRuntime(siteId);
  if (!created.ok) return created;
  const { runtime } = created;
  try {
    if (!runtime.probeThirdPartyBlocks) {
      return {
        ok: false,
        code: "unsupported",
        message: "This SitePilot runtime cannot test third-party blocks."
      };
    }
    return { ok: true, report: await runtime.probeThirdPartyBlocks() };
  } catch (error) {
    return {
      ok: false,
      code: "block_test_failed",
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message.slice(0, 1_000)
          : "The third-party block test could not run."
    };
  } finally {
    await runtime.close().catch(() => undefined);
  }
}
