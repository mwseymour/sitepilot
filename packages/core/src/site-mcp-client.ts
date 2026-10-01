import { McpHttpClient } from "@sitepilot/mcp-client";
import type { SiteId } from "@sitepilot/domain";
import { siteRestUrl } from "@sitepilot/plugin-protocol";

import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import { createSignedMcpFetch } from "./signed-fetch.js";
import { ensureSiteRestRoot } from "./site-site-context.js";

export type SiteMcpClientResult =
  | { ok: true; client: McpHttpClient }
  | { ok: false; code: string; message: string };

export async function createMcpClientForSite(
  siteId: SiteId
): Promise<SiteMcpClientResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  const conn = await db.repositories.siteConnections.getBySiteId(siteId);
  if (!site || !conn) {
    return {
      ok: false,
      code: "site_not_ready",
      message: "Site or connection not found."
    };
  }
  const secretB64 = await getSecureStorage().get({
    namespace: "site",
    keyId: siteId
  });
  if (!secretB64) {
    return {
      ok: false,
      code: "secret_missing",
      message: "Site signing secret not found."
    };
  }
  const secret = Buffer.from(secretB64, "base64");
  await ensureSiteRestRoot(site.baseUrl);
  const mcpUrl = siteRestUrl(site.baseUrl, "sitepilot/mcp");
  const signedFetch = createSignedMcpFetch({
    sharedSecret: secret,
    siteId,
    clientId: conn.clientIdentifier
  });
  const client = new McpHttpClient({
    endpointUrl: mcpUrl,
    fetchFn: signedFetch
  });
  await client.connect();
  return { ok: true, client };
}
