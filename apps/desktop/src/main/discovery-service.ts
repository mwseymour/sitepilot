import { randomUUID } from "node:crypto";

import type { DiscoverySnapshot, Site } from "@sitepilot/domain";
import { normalizeMcpToolResult } from "@sitepilot/mcp-client";

import { getDatabase } from "./app-database.js";
import {
  createMcpClientForSite,
  loadRegisteredSiteContext
} from "./site-site-context.js";

export type RefreshDiscoveryResult =
  | { ok: true; snapshot: DiscoverySnapshot }
  | { ok: false; code: string; message: string };

export async function refreshDiscoveryForSite(
  siteId: string
): Promise<RefreshDiscoveryResult> {
  const ctx = await loadRegisteredSiteContext(siteId);
  if (!ctx.ok) {
    return { ok: false, code: ctx.code, message: ctx.message };
  }

  const mcpBundle = await createMcpClientForSite(
    siteId,
    ctx.site,
    ctx.connection,
    ctx.secret
  );
  if (!mcpBundle.ok) {
    return { ok: false, code: mcpBundle.code, message: mcpBundle.message };
  }

  try {
    await mcpBundle.client.connect();
  } catch (e) {
    return {
      ok: false,
      code: "mcp_connect_failed",
      message: e instanceof Error ? e.message : "MCP initialize failed"
    };
  }

  let toolNames: string[] = [];
  try {
    const listed = await mcpBundle.client.listTools();
    toolNames = listed.tools.map((t) => t.name);
  } catch {
    toolNames = [];
  }

  let discoveryPayload: Record<string, unknown>;
  try {
    const raw = await mcpBundle.client.callTool("sitepilot-site-discovery", {});
    discoveryPayload = normalizeMcpToolResult(raw);
  } catch (e) {
    return {
      ok: false,
      code: "discovery_tool_failed",
      message:
        e instanceof Error ? e.message : "sitepilot-site-discovery call failed"
    };
  }

  const remoteWarnings = discoveryPayload["warnings"];
  const extraWarnings: string[] = Array.isArray(remoteWarnings)
    ? remoteWarnings.filter((w): w is string => typeof w === "string")
    : [];

  const db = getDatabase();
  const previous = await db.repositories.discoverySnapshots.getLatest(
    ctx.site.id
  );
  const revision = previous ? previous.revision + 1 : 1;
  const now = new Date().toISOString();

  const summary: Record<string, unknown> = {
    mcp: {
      endpoint: mcpBundle.mcpUrl,
      pluginProtocolVersion: mcpBundle.protocol.protocol_version,
      pluginVersion: mcpBundle.protocol.plugin_version
    },
    discovery: discoveryPayload
  };

  const snapshot: DiscoverySnapshot = {
    id: randomUUID() as DiscoverySnapshot["id"],
    siteId: ctx.site.id,
    revision,
    warnings: extraWarnings,
    capabilities: toolNames,
    summary,
    createdAt: now,
    updatedAt: now
  };

  await db.repositories.discoverySnapshots.save(snapshot);

  const siteRow = await db.repositories.sites.getById(ctx.site.id);
  if (siteRow) {
    const updated: Site = {
      ...siteRow,
      latestDiscoverySnapshotId: snapshot.id,
      updatedAt: now
    };
    await db.repositories.sites.save(updated);
  }

  return { ok: true, snapshot };
}
