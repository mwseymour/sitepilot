import { randomBytes, randomUUID } from "node:crypto";

import {
  siteRegistrationHandshakeRequestSchema,
  type RegisterSiteResponse
} from "@sitepilot/contracts";
import type { Site, SiteConnection } from "@sitepilot/domain";
import { z } from "zod";
import { McpHttpClient } from "@sitepilot/mcp-client";
import {
  compareProtocolCompatibility,
  fingerprintSharedSecret,
  parseSiteRegistration
} from "@sitepilot/plugin-protocol";
import { getDatabase } from "./app-database.js";
import { getSecureStorage } from "./app-secure-storage.js";
import { createSignedMcpFetch } from "./signed-fetch.js";
import { SITEPILOT_PROTOCOL_VERSION } from "./compatibility-info.js";

import type { SecretKey } from "@sitepilot/services";

const protocolMetadataSchema = z.object({
  protocol_version: z.string().min(1),
  plugin_version: z.string().min(1),
  mcp_namespace: z.string().min(1),
  mcp_route: z.string().min(1)
});

const clientIdKey: SecretKey = {
  namespace: "signing",
  keyId: "sitepilot-desktop-client-id"
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function getOrCreateClientId(): Promise<string> {
  const secure = getSecureStorage();
  const existing = await secure.get(clientIdKey);
  if (existing) {
    return existing;
  }
  const id = `sitepilot-desktop-${randomUUID()}`;
  await secure.set(clientIdKey, id);
  return id;
}

export type RegisterSiteRequest = {
  baseUrl: string;
  registrationCode: string;
  siteName: string;
  workspaceId?: string;
  environment?: Site["environment"];
  trustedAppOrigin?: string;
};

export async function registerSiteWithWordPress(
  request: RegisterSiteRequest
): Promise<RegisterSiteResponse> {
  try {
    const base = normalizeBaseUrl(request.baseUrl);
    const protocolRes = await fetch(`${base}/wp-json/sitepilot/v1/protocol`);
    if (!protocolRes.ok) {
      return {
        ok: false,
        code: "protocol_unreachable",
        message: `Protocol metadata HTTP ${protocolRes.status}`
      };
    }

    const protocolJson: unknown = await protocolRes.json();
    const protocol = protocolMetadataSchema.safeParse(protocolJson);
    if (!protocol.success) {
      return {
        ok: false,
        code: "protocol_invalid",
        message: "Unexpected protocol metadata from site"
      };
    }

    const compat = compareProtocolCompatibility(
      protocol.data.protocol_version,
      SITEPILOT_PROTOCOL_VERSION
    );
    if (!compat.ok) {
      return {
        ok: false,
        code: "protocol_incompatible",
        message: compat.reason
      };
    }

    const siteId = randomUUID();
    const workspaceId = request.workspaceId ?? "workspace-1";
    const secret = randomBytes(32);
    const sharedSecretBase64 = secret.toString("base64");
    const clientIdentifier = await getOrCreateClientId();
    const trustedAppOrigin =
      request.trustedAppOrigin ?? "https://sitepilot.desktop";

    const handshakeBody = siteRegistrationHandshakeRequestSchema.parse({
      registrationCode: request.registrationCode,
      siteId,
      workspaceId,
      trustedAppOrigin,
      clientIdentifier,
      protocolVersion: SITEPILOT_PROTOCOL_VERSION,
      siteName: request.siteName,
      siteBaseUrl: base,
      environment: request.environment ?? "production",
      sharedSecretBase64
    });

    const registerRes = await fetch(`${base}/wp-json/sitepilot/v1/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(handshakeBody)
    });

    const registerText = await registerRes.text();
    let registerJson: unknown;
    try {
      registerJson = JSON.parse(registerText) as unknown;
    } catch {
      return {
        ok: false,
        code: "register_invalid_json",
        message: `Registration failed (${registerRes.status})`
      };
    }

    if (!registerRes.ok) {
      const err = registerJson as { message?: string };
      return {
        ok: false,
        code: "register_rejected",
        message:
          typeof err.message === "string"
            ? err.message
            : `Registration failed (${registerRes.status})`
      };
    }

    const registrationParsed = parseSiteRegistration(registerJson);
    if (!registrationParsed.success) {
      return {
        ok: false,
        code: "registration_invalid",
        message: "Site returned invalid registration payload"
      };
    }

    const registration = registrationParsed.data;
    const secure = getSecureStorage();
    await secure.set({ namespace: "site", keyId: siteId }, sharedSecretBase64);

    const now = new Date().toISOString();
    const site: Site = {
      id: siteId as Site["id"],
      workspaceId: workspaceId as Site["workspaceId"],
      name: request.siteName,
      baseUrl: base,
      environment: request.environment ?? "production",
      activationStatus: "config_required",
      createdAt: now,
      updatedAt: now
    };

    const fingerprint = fingerprintSharedSecret(secret);
    const connection: SiteConnection = {
      id: randomUUID() as SiteConnection["id"],
      siteId: site.id,
      status: "verified",
      protocolVersion: registration.protocolVersion,
      pluginVersion: registration.pluginVersion,
      clientIdentifier: registration.clientIdentifier,
      trustedAppOrigin: registration.trustedAppOrigin,
      credentialFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now
    };

    const db = getDatabase();
    await db.repositories.sites.save(site);
    await db.repositories.siteConnections.save(connection);

    const mcpUrl = `${base}/wp-json/${protocol.data.mcp_namespace}/${protocol.data.mcp_route}`;
    const signedFetch = createSignedMcpFetch({
      sharedSecret: secret,
      siteId,
      clientId: clientIdentifier
    });
    const mcp = new McpHttpClient({
      endpointUrl: mcpUrl,
      fetchFn: signedFetch
    });
    await mcp.connect();
    const tools = await mcp.listTools();

    return {
      ok: true,
      site: {
        id: site.id,
        workspaceId: site.workspaceId,
        name: site.name,
        baseUrl: site.baseUrl,
        environment: site.environment,
        activationStatus: site.activationStatus
      },
      registration,
      mcpToolCount: tools.tools.length
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected registration error";
    return {
      ok: false,
      code: "register_failed",
      message
    };
  }
}
