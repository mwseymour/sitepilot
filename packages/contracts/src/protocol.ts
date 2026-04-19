import { z } from "zod";

import {
  idSchema,
  isoTimestampSchema,
  siteConnectionStatusSchema,
  siteEnvironmentSchema,
  urlSchema
} from "./common.js";

export const registrationCredentialSchema = z.object({
  algorithm: z.enum(["ed25519", "hmac_sha256"]),
  publicKey: z.string().optional(),
  sharedSecretFingerprint: z.string().optional()
});

export const siteRegistrationSchema = z.object({
  siteId: idSchema,
  workspaceId: idSchema,
  trustedAppOrigin: urlSchema,
  clientIdentifier: z.string().min(1),
  protocolVersion: z.string().min(1),
  pluginVersion: z.string().min(1),
  createdAt: isoTimestampSchema,
  status: siteConnectionStatusSchema,
  credential: registrationCredentialSchema
});

/**
 * One-time desktop → WordPress registration (HTTPS). The shared secret is
 * transmitted only in this request; the plugin stores it server-side for
 * signature verification; the desktop stores it only in secure storage.
 */
export const siteRegistrationHandshakeRequestSchema = z.object({
  registrationCode: z.string().min(1),
  siteId: idSchema,
  workspaceId: idSchema,
  trustedAppOrigin: urlSchema,
  clientIdentifier: z.string().min(1),
  protocolVersion: z.string().min(1),
  siteName: z.string().min(1),
  siteBaseUrl: urlSchema,
  environment: siteEnvironmentSchema,
  sharedSecretBase64: z.string().min(1)
});

export const signedRequestHeadersSchema = z.object({
  "x-sitepilot-request-id": z.string().min(1),
  "x-sitepilot-site-id": idSchema,
  "x-sitepilot-client-id": z.string().min(1),
  "x-sitepilot-timestamp": isoTimestampSchema,
  "x-sitepilot-nonce": z.string().min(12),
  "x-sitepilot-signature": z.string().min(32),
  "x-sitepilot-payload-sha256": z.string().length(64)
});

export const pluginCapabilitySchema = z.object({
  namespace: z.string().min(1),
  toolName: z.string().min(1),
  readOnly: z.boolean(),
  dryRunSupported: z.boolean(),
  riskLevel: z.enum(["low", "medium", "high", "critical"])
});

export const protocolHealthSchema = z.object({
  siteId: idSchema,
  protocolVersion: z.string().min(1),
  pluginVersion: z.string().min(1),
  status: siteConnectionStatusSchema,
  capabilities: z.array(pluginCapabilitySchema),
  checkedAt: isoTimestampSchema
});

export type SiteRegistration = z.infer<typeof siteRegistrationSchema>;
export type SiteRegistrationHandshakeRequest = z.infer<
  typeof siteRegistrationHandshakeRequestSchema
>;
export type SignedRequestHeaders = z.infer<typeof signedRequestHeadersSchema>;
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
export type ProtocolHealth = z.infer<typeof protocolHealthSchema>;
