import type { ConnectivityDiagnosticsResult } from "@sitepilot/contracts";
import { compareProtocolCompatibility } from "@sitepilot/plugin-protocol";

import {
  createMcpClientForSite,
  fetchProtocolMetadata,
  loadRegisteredSiteContext,
  normalizeBaseUrl
} from "./site-site-context.js";
import { fetchSiteUrl } from "./site-fetch.js";

const SITEPILOT_PROTOCOL_VERSION = "1.0.0";

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
    checks.authentication = {
      ok: false,
      message: e instanceof Error ? e.message : "MCP initialize failed"
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
