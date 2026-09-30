import type {
  AuthFailureReason,
  ConnectivityDiagnosticsResult
} from "@sitepilot/contracts";
import { McpHttpError } from "@sitepilot/mcp-client";
import { compareProtocolCompatibility } from "@sitepilot/plugin-protocol";

import {
  createMcpClientForSite,
  fetchProtocolMetadata,
  loadRegisteredSiteContext,
  normalizeBaseUrl
} from "./site-site-context.js";
import { fetchSiteUrl } from "./site-fetch.js";

const SITEPILOT_PROTOCOL_VERSION = "1.0.0";

const SIGNING_HEADERS = [
  "x-sitepilot-site-id",
  "x-sitepilot-client-id",
  "x-sitepilot-request-id",
  "x-sitepilot-timestamp",
  "x-sitepilot-nonce",
  "x-sitepilot-payload-sha256",
  "x-sitepilot-signature"
] as const;

/** What to do about each refusal, in plain words. */
const AUTH_REASON_ADVICE: Record<AuthFailureReason, string> = {
  headers_missing:
    "The site didn't receive SitePilot's signing headers. A host, proxy or security plugin may be stripping them.",
  invalid_signed_headers:
    "The site received malformed signing headers. A proxy may be rewriting them.",
  invalid_iso_timestamp:
    "The site couldn't read the request time. A proxy may be rewriting the headers.",
  timestamp_outside_skew:
    "This computer's clock and the site's clock are more than a few minutes apart. Check both clocks.",
  nonce_replayed:
    "The site saw the same request twice. A proxy or cache may be replaying requests; try again.",
  payload_sha256_mismatch:
    "The request body changed on the way to the site. A proxy or security plugin may be rewriting it.",
  unknown_site:
    "The site doesn't know this registration. It may have been revoked; register the site again.",
  no_mapped_user:
    "The registration's WordPress user no longer exists. Register the site again with an existing user.",
  client_mismatch:
    "The site has this registration under a different client. Register the site again.",
  signature_invalid:
    "The signature didn't match. The registration secret may be out of date; register the site again."
};

/**
 * Which signing headers reach the site. Values are placeholders: the route
 * only reports names, so nothing secret is sent. Undefined for plugins
 * without the route.
 */
async function missingSigningHeaders(
  base: string
): Promise<string[] | undefined> {
  try {
    const response = await fetchSiteUrl(
      `${base}/wp-json/sitepilot/v1/echo-headers`,
      {
        headers: Object.fromEntries(
          SIGNING_HEADERS.map((name) => [name, "diagnostic"])
        ),
        signal: AbortSignal.timeout(15_000)
      }
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { missing?: unknown };
    return Array.isArray(body.missing)
      ? body.missing.filter((name): name is string => typeof name === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

export async function runConnectivityDiagnostics(
  siteId: string
): Promise<ConnectivityDiagnosticsResult> {
  const checkedAt = new Date().toISOString();
  const ctx = await loadRegisteredSiteContext(siteId);
  const checks: ConnectivityDiagnosticsResult["checks"] = {
    health: { ok: false },
    protocolMetadata: { ok: false },
    authentication: { ok: false },
    mcpTools: { ok: false, toolNames: [] },
    pluginVersion: { ok: false }
  };

  if (!ctx.ok) {
    checks.authentication = {
      ok: false,
      message: ctx.message
    };
    return {
      siteId,
      checkedAt,
      overallOk: false,
      checks
    };
  }

  const base = normalizeBaseUrl(ctx.site.baseUrl);

  const healthStarted = Date.now();
  try {
    const healthRes = await fetchSiteUrl(`${base}/wp-json/sitepilot/v1/health`, {
      signal: AbortSignal.timeout(15_000)
    });
    const latencyMs = Date.now() - healthStarted;
    checks.health = {
      ok: healthRes.ok,
      httpStatus: healthRes.status,
      latencyMs,
      message: healthRes.ok ? undefined : `HTTP ${healthRes.status}`
    };
  } catch (e) {
    checks.health = {
      ok: false,
      message: e instanceof Error ? e.message : "Health request failed"
    };
  }

  const proto = await fetchProtocolMetadata(ctx.site.baseUrl);
  if (proto.ok) {
    const compat = compareProtocolCompatibility(
      proto.data.protocol_version,
      SITEPILOT_PROTOCOL_VERSION
    );
    checks.protocolMetadata = {
      ok: true,
      protocolVersion: proto.data.protocol_version,
      pluginVersion: proto.data.plugin_version,
      compatibilityOk: compat.ok,
      compatibilityReason: compat.ok ? undefined : compat.reason,
      latencyMs: proto.latencyMs,
      message: compat.ok ? undefined : compat.reason
    };
    checks.pluginVersion = {
      ok: true,
      version: proto.data.plugin_version
    };
  } else {
    checks.protocolMetadata = {
      ok: false,
      message: proto.message
    };
    checks.pluginVersion = {
      ok: false,
      message: proto.message
    };
  }

  const mcpBundle = await createMcpClientForSite(
    siteId,
    ctx.site,
    ctx.connection,
    ctx.secret
  );
  if (!mcpBundle.ok) {
    checks.authentication = { ok: false, message: mcpBundle.message };
    return { siteId, checkedAt, overallOk: false, checks };
  }

  try {
    await mcpBundle.client.connect();
    checks.authentication = { ok: true };
  } catch (e) {
    const reason = e instanceof McpHttpError ? e.error.auth?.reason : undefined;
    const missingHeaders =
      reason === undefined || reason === "headers_missing"
        ? await missingSigningHeaders(base)
        : undefined;
    const stripped =
      missingHeaders !== undefined && missingHeaders.length > 0
        ? `The site never received these signing headers: ${missingHeaders.join(", ")}. A host, proxy or security plugin is stripping them.`
        : undefined;
    checks.authentication = {
      ok: false,
      message:
        stripped ??
        (reason !== undefined
          ? AUTH_REASON_ADVICE[reason]
          : e instanceof Error
            ? e.message
            : "MCP initialize failed"),
      ...(reason !== undefined ? { reason } : {}),
      ...(missingHeaders !== undefined && missingHeaders.length > 0
        ? { missingHeaders }
        : {})
    };
    return { siteId, checkedAt, overallOk: false, checks };
  }

  try {
    const tools = await mcpBundle.client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    checks.mcpTools = {
      ok: true,
      toolNames,
      message: toolNames.length === 0 ? "No MCP tools reported" : undefined
    };
  } catch (e) {
    checks.mcpTools = {
      ok: false,
      toolNames: [],
      message: e instanceof Error ? e.message : "tools/list failed"
    };
  }

  const protocolOk =
    checks.protocolMetadata.ok &&
    checks.protocolMetadata.compatibilityOk === true;

  const overallOk =
    checks.health.ok &&
    protocolOk &&
    checks.authentication.ok &&
    checks.mcpTools.ok &&
    checks.pluginVersion.ok;

  return {
    siteId,
    checkedAt,
    overallOk,
    checks
  };
}
