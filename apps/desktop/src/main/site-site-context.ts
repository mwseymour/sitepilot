import { z } from "zod";

import type { Site, SiteConnection } from "@sitepilot/domain";
import { McpHttpClient } from "@sitepilot/mcp-client";

import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import { createSignedMcpFetch } from "./signed-fetch.js";
import { fetchSiteUrl } from "./site-fetch.js";

const protocolMetadataSchema = z.object({
  protocol_version: z.string().min(1),
  plugin_version: z.string().min(1),
  mcp_namespace: z.string().min(1),
  mcp_route: z.string().min(1)
});

export type ProtocolMetadata = z.infer<typeof protocolMetadataSchema>;

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export type RegisteredSiteContext =
  | {
      ok: true;
      site: Site;
      connection: SiteConnection;
      secret: Buffer;
    }
  | { ok: false; code: string; message: string };

export async function loadRegisteredSiteContext(
  siteId: string
): Promise<RegisteredSiteContext> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId as Site["id"]);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Unknown site id" };
  }

  const connection = await db.repositories.siteConnections.getBySiteId(site.id);
  if (!connection) {
    return {
      ok: false,
      code: "site_not_connected",
      message: "No connection record for this site"
    };
  }
  if (connection.status !== "verified") {
    return {
      ok: false,
      code: "site_not_verified",
      message: "Site connection is not verified"
    };
  }

  const secure = getSecureStorage();
  const secretB64 = await secure.get({
    namespace: "site",
    keyId: siteId
  });
  if (!secretB64) {
    return {
      ok: false,
      code: "site_secret_missing",
      message: "Shared secret not found in secure storage"
    };
  }

  const secret = Buffer.from(secretB64, "base64");
  return { ok: true, site, connection, secret };
}

export async function fetchProtocolMetadata(
  baseUrl: string
): Promise<
  | { ok: true; data: ProtocolMetadata; latencyMs: number }
  | { ok: false; code: string; message: string; httpStatus?: number }
> {
  const base = normalizeBaseUrl(baseUrl);
  const started = Date.now();
  let protocolRes: Response;
  try {
    protocolRes = await fetchSiteUrl(`${base}/wp-json/sitepilot/v1/protocol`, {
      signal: AbortSignal.timeout(15_000)
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Network error";
    return { ok: false, code: "protocol_unreachable", message };
  }
  const latencyMs = Date.now() - started;

  if (!protocolRes.ok) {
    return {
      ok: false,
      code: "protocol_http_error",
      message: `Protocol endpoint HTTP ${protocolRes.status}`,
      httpStatus: protocolRes.status
    };
  }

  let json: unknown;
  try {
    json = await protocolRes.json();
  } catch {
    return {
      ok: false,
      code: "protocol_invalid_json",
      message: "Protocol endpoint returned non-JSON"
    };
  }

  const parsed = protocolMetadataSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "protocol_invalid_shape",
      message: "Unexpected protocol metadata"
    };
  }

  return { ok: true, data: parsed.data, latencyMs };
}

export type McpClientBundle =
  | {
      ok: true;
      client: McpHttpClient;
      mcpUrl: string;
      protocol: ProtocolMetadata;
    }
  | { ok: false; code: string; message: string };

export async function createMcpClientForSite(
  siteId: string,
  site: Site,
  connection: SiteConnection,
  secret: Buffer
): Promise<McpClientBundle> {
  const proto = await fetchProtocolMetadata(site.baseUrl);
  if (!proto.ok) {
    return { ok: false, code: proto.code, message: proto.message };
  }

  const base = normalizeBaseUrl(site.baseUrl);
  const mcpUrl = `${base}/wp-json/${proto.data.mcp_namespace}/${proto.data.mcp_route}`;
  const signedFetch = createSignedMcpFetch({
    sharedSecret: secret,
    siteId,
    clientId: connection.clientIdentifier
  });
  const client = new McpHttpClient({
    endpointUrl: mcpUrl,
    fetchFn: signedFetch
  });

  return { ok: true, client, mcpUrl, protocol: proto.data };
}
