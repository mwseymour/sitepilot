import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildSigningInput,
  compareProtocolCompatibility,
  fingerprintSharedSecret,
  isCredentialRevoked,
  parseProtocolVersion,
  parseSignedRequestHeaders,
  parseSiteRegistration,
  SeenNonceCache,
  signSitePilotHmacRequest,
  validateSignedRequest,
  validateTimestampWithinSkew,
  verifyRequestSignature
} from "@sitepilot/plugin-protocol";

describe("plugin protocol — versions", () => {
  it("parses semver-like protocol strings", () => {
    expect(parseProtocolVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3
    });
    expect(parseProtocolVersion("bad")).toBeNull();
  });

  it("compares plugin vs app protocol compatibility", () => {
    expect(compareProtocolCompatibility("1.0.0", "1.2.0").ok).toBe(true);
    expect(compareProtocolCompatibility("1.3.0", "1.2.0").ok).toBe(false);
    expect(compareProtocolCompatibility("2.0.0", "1.0.0").ok).toBe(false);
  });
});

describe("plugin protocol — revocation", () => {
  it("detects revoked credentials", () => {
    const list = [
      { credentialFingerprint: "fp-a", revokedAt: "2025-01-01T00:00:00.000Z" }
    ];
    expect(isCredentialRevoked("fp-a", list, "2026-01-01T00:00:00.000Z")).toBe(
      true
    );
    expect(isCredentialRevoked("fp-b", list, "2026-01-01T00:00:00.000Z")).toBe(
      false
    );
  });
});

describe("plugin protocol — signed headers", () => {
  const baseHeaders = {
    "X-SitePilot-Request-Id": "req-1",
    "x-sitepilot-site-id": "site-1",
    "x-sitepilot-client-id": "client-1",
    "x-sitepilot-timestamp": "2026-04-19T12:00:00.000Z",
    "x-sitepilot-nonce": "123456789012",
    "x-sitepilot-signature": "a".repeat(32),
    "x-sitepilot-payload-sha256": "b".repeat(64)
  };

  it("parses headers case-insensitively", () => {
    const parsed = parseSignedRequestHeaders(baseHeaders);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data["x-sitepilot-request-id"]).toBe("req-1");
    }
  });

  it("validates timestamp skew and nonce cache", () => {
    const cache = new SeenNonceCache(60_000, 100);
    const nowMs = Date.parse("2026-04-19T12:00:00.000Z");
    const first = validateSignedRequest({
      headers: baseHeaders,
      nowMs,
      maxSkewMs: 120_000,
      nonceCache: cache
    });
    expect(first.ok).toBe(true);

    const replay = validateSignedRequest({
      headers: baseHeaders,
      nowMs,
      maxSkewMs: 120_000,
      nonceCache: cache
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.reason).toBe("replay");
    }
  });

  it("rejects stale timestamps", () => {
    const cache = new SeenNonceCache(60_000, 100);
    const result = validateSignedRequest({
      headers: {
        ...baseHeaders,
        "x-sitepilot-timestamp": "2020-01-01T00:00:00.000Z",
        "x-sitepilot-nonce": "987654321098"
      },
      nowMs: Date.parse("2026-04-19T12:00:00.000Z"),
      maxSkewMs: 1000,
      nonceCache: cache
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timestamp_outside_skew");
    }
  });
});

describe("plugin protocol — timing", () => {
  it("validates ISO timestamps within skew", () => {
    const nowMs = Date.parse("2026-04-19T12:00:00.000Z");
    expect(
      validateTimestampWithinSkew("2026-04-19T12:00:00.000Z", {
        nowMs,
        maxSkewMs: 5000
      }).ok
    ).toBe(true);
    expect(
      validateTimestampWithinSkew("not-a-date", {
        nowMs,
        maxSkewMs: 5000
      }).ok
    ).toBe(false);
  });
});

describe("plugin protocol — signing", () => {
  it("verifies HMAC-SHA256 signatures over the canonical input", () => {
    const secret = Buffer.from("shared-secret");
    const input = buildSigningInput({
      method: "POST",
      path: "/wp-json/sitepilot/v1/x",
      siteId: "site-1",
      requestId: "req-1",
      clientId: "client-1",
      timestamp: "2026-04-19T12:00:00.000Z",
      nonce: "nonce-1",
      payloadSha256Hex: "a".repeat(64)
    });
    const mac = createHmac("sha256", secret).update(input, "utf8").digest();
    expect(
      verifyRequestSignature({
        algorithm: "hmac_sha256",
        sharedSecret: secret,
        signingInput: input,
        signatureHex: mac.toString("hex")
      })
    ).toBe(true);
    expect(
      verifyRequestSignature({
        algorithm: "hmac_sha256",
        sharedSecret: secret,
        signingInput: input,
        signatureHex: "00".repeat(32)
      })
    ).toBe(false);
  });

  it("verifies ed25519 signatures", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const input = buildSigningInput({
      method: "GET",
      path: "/",
      siteId: "s",
      requestId: "r",
      clientId: "c",
      timestamp: "2026-04-19T12:00:00.000Z",
      nonce: "n",
      payloadSha256Hex: "c".repeat(64)
    });
    const sig = sign(null, Buffer.from(input, "utf8"), privateKey);
    const pem = publicKey.export({ type: "spki", format: "pem" });
    if (typeof pem !== "string") {
      throw new Error("expected pem string");
    }
    expect(
      verifyRequestSignature({
        algorithm: "ed25519",
        publicKey: pem,
        signingInput: input,
        signatureHex: sig.toString("hex")
      })
    ).toBe(true);
  });
});

describe("plugin protocol — client signing", () => {
  it("round-trips HMAC headers via verifyRequestSignature", () => {
    const secret = Buffer.from("registration-secret");
    const bodyBuffer = Buffer.from('{"jsonrpc":"2.0","id":1}', "utf8");
    const headers = signSitePilotHmacRequest({
      method: "POST",
      path: "/wp-json/sitepilot/mcp",
      siteId: "site-1",
      clientId: "client-1",
      bodyBuffer,
      sharedSecret: secret,
      requestId: "req-1",
      nonce: "123456789012",
      timestampIso: "2026-04-19T12:00:00.000Z"
    });
    const payloadSha = headers["x-sitepilot-payload-sha256"];
    const signingInput = buildSigningInput({
      method: "POST",
      path: "/wp-json/sitepilot/mcp",
      siteId: "site-1",
      requestId: "req-1",
      clientId: "client-1",
      timestamp: "2026-04-19T12:00:00.000Z",
      nonce: "123456789012",
      payloadSha256Hex: payloadSha
    });
    expect(
      verifyRequestSignature({
        algorithm: "hmac_sha256",
        sharedSecret: secret,
        signingInput,
        signatureHex: headers["x-sitepilot-signature"]
      })
    ).toBe(true);
    expect(fingerprintSharedSecret(secret)).toHaveLength(64);
  });
});

describe("plugin protocol — registration parse", () => {
  it("accepts a valid site registration payload", () => {
    const result = parseSiteRegistration({
      siteId: "site-1",
      workspaceId: "ws-1",
      trustedAppOrigin: "https://app.example",
      clientIdentifier: "desktop",
      protocolVersion: "1.0.0",
      pluginVersion: "0.1.0",
      createdAt: "2026-04-19T12:00:00.000Z",
      status: "verified",
      credential: { algorithm: "ed25519", publicKey: "abc" }
    });
    expect(result.success).toBe(true);
  });
});
