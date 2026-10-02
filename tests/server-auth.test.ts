import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { seedDefaultWorkspace } from "../packages/core/src/app-database.js";
import { initializePostgresDatabase } from "@sitepilot/repositories";

import {
  AuthStore,
  SIGN_IN_SCHEMA,
  rolesFromCapabilities,
  verifySignInAssertion,
  type SignInAssertion
} from "../apps/server/src/auth.js";
import {
  TEST_POSTGRES_URL,
  createTestPostgresDatabase
} from "./postgres-test-database.js";

const secret = Buffer.from("a shared secret of at least sixteen bytes");
const now = 1_790_000_000;

function signed(fields: Record<string, unknown>, key = secret) {
  const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`${SIGN_IN_SCHEMA}\n${payload}`)
    .digest("base64url");
  return { payload, signature };
}

const assertionFields = {
  schema: SIGN_IN_SCHEMA,
  siteId: "site-1",
  state: "state-abcdefghijklmnop",
  nonce: "0123456789abcdef0123456789abcdef",
  issuedAt: now,
  expiresAt: now + 120,
  user: { id: 42, login: "ann", email: "ann@example.com", displayName: "Ann Editor", roles: ["editor"] },
  capabilities: { read: true, edit_posts: true, publish_posts: true, edit_others_posts: true, manage_options: false }
};

describe("Sign in with WordPress assertions", () => {
  it("accepts a signed, current assertion", () => {
    const result = verifySignInAssertion({ ...signed(assertionFields), sharedSecret: secret, nowSeconds: now });
    expect(result.ok && result.assertion.user.login).toBe("ann");
  });

  it("refuses another key, a changed payload, an expired one or the wrong schema", () => {
    const other = signed(assertionFields, Buffer.from("someone else's secret, sixteen+"));
    expect(verifySignInAssertion({ ...other, sharedSecret: secret, nowSeconds: now })).toEqual({ ok: false, reason: "signature_invalid" });

    const original = signed(assertionFields);
    const tampered = Buffer.from(JSON.stringify({ ...assertionFields, user: { ...assertionFields.user, id: 1 } })).toString("base64url");
    expect(verifySignInAssertion({ payload: tampered, signature: original.signature, sharedSecret: secret, nowSeconds: now }).ok).toBe(false);

    expect(verifySignInAssertion({ ...signed(assertionFields), sharedSecret: secret, nowSeconds: now + 121 })).toEqual({ ok: false, reason: "expired" });
    expect(
      verifySignInAssertion({ ...signed({ ...assertionFields, schema: "other" }), sharedSecret: secret, nowSeconds: now })
    ).toEqual({ ok: false, reason: "payload_invalid" });
  });

  it("gives approval to people who can publish, and requests to other editors", () => {
    expect(rolesFromCapabilities({ manage_options: true, publish_posts: true }).appRole).toBe("admin");
    expect(rolesFromCapabilities({ publish_posts: true, edit_posts: true }).siteRoles).toContain("approve");
    expect(rolesFromCapabilities({ edit_posts: true })).toEqual({ appRole: "requester", siteRoles: ["request", "edit_drafts"] });
    expect(rolesFromCapabilities({ read: true })).toEqual({ appRole: "read_only_auditor", siteRoles: ["audit_only"] });
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!TEST_POSTGRES_URL)("hosted sign-in store", () => {
  async function store() {
    const created = await createTestPostgresDatabase();
    cleanups.push(created.drop);
    const database = await initializePostgresDatabase({ connectionString: created.url, max: 2 });
    cleanups.push(database.close);
    await seedDefaultWorkspace(database);
    await database.repositories.sites.save({
      id: "site-1" as never,
      workspaceId: "workspace-1" as never,
      name: "Example",
      baseUrl: "https://example.com",
      environment: "production",
      activationStatus: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z"
    });
    return new AuthStore(database.sql);
  }

  it("links the user, keeps their role current and serves sessions and tokens", async () => {
    const auth = await store();
    const assertion = assertionFields as unknown as SignInAssertion;
    const user = await auth.linkIdentity({ assertion, workspaceId: "workspace-1" });
    expect(user).toMatchObject({ userProfileId: "wp-site-1-42", appRole: "approver" });

    const session = await auth.createSession(user);
    expect((await auth.userForSession(session))?.login).toBe("ann");
    expect(await auth.userForSession("not-a-session")).toBeNull();

    // Losing publish rights in WordPress takes effect at the next sign-in.
    await auth.linkIdentity({
      assertion: { ...assertion, capabilities: { edit_posts: true } },
      workspaceId: "workspace-1"
    });
    expect((await auth.userForSession(session))?.siteRoles).not.toContain("approve");

    const token = await auth.createApiToken(user, "Claude Code");
    expect(token).toMatch(/^spt_/);
    expect((await auth.userForApiToken(token))?.userProfileId).toBe("wp-site-1-42");
    const [listed] = await auth.listApiTokens(user);
    await auth.revokeApiToken(user, listed!.tokenHash);
    expect(await auth.userForApiToken(token)).toBeNull();

    await auth.endSession(session);
    expect(await auth.userForSession(session)).toBeNull();
  });

  it("lets a site admin set someone's role, or turn SitePilot off for them", async () => {
    const auth = await store();
    const assertion = assertionFields as unknown as SignInAssertion;
    const user = (await auth.linkIdentity({ assertion, workspaceId: "workspace-1" }))!;
    const session = await auth.createSession(user);
    const token = await auth.createApiToken(user, "Codex");

    expect(await auth.setRoleOverride(user, "requester", "Ada Admin")).toBe(true);
    expect(await auth.userForSession(session)).toMatchObject({ appRole: "requester", roleSetByAdmin: true });
    expect((await auth.userForApiToken(token))?.siteRoles).not.toContain("approve");
    // Signing in again refreshes the WordPress role, and the admin's still wins.
    expect(await auth.linkIdentity({ assertion, workspaceId: "workspace-1" })).toMatchObject({ appRole: "requester" });
    expect(await auth.listPeople("site-1")).toEqual([
      expect.objectContaining({ login: "ann", wordpressRole: "approver", roleOverride: "requester", roleOverrideBy: "Ada Admin" })
    ]);

    // No access: every way in stops, signing in again included.
    await auth.setRoleOverride(user, "none", "Ada Admin");
    expect(await auth.userForSession(session)).toBeNull();
    expect(await auth.userForApiToken(token)).toBeNull();
    expect(await auth.userFor("site-1", 42)).toBeNull();
    expect(await auth.linkIdentity({ assertion, workspaceId: "workspace-1" })).toBeNull();

    // Back to the role from WordPress.
    await auth.setRoleOverride(user, null, "Ada Admin");
    const restored = await auth.userForSession(session);
    expect(restored).toMatchObject({ appRole: "approver" });
    expect(restored?.roleSetByAdmin).toBeUndefined();

    // WordPress administrators stay admins.
    const admin = (await auth.linkIdentity({
      assertion: { ...assertion, user: { ...assertion.user, id: 7, login: "ada" }, capabilities: { manage_options: true } },
      workspaceId: "workspace-1"
    }))!;
    expect(await auth.setRoleOverride(admin, "none", "Someone")).toBe(false);
    expect((await auth.userFor("site-1", 7))?.appRole).toBe("admin");

    // Signing someone out everywhere ends their sessions, not their tokens.
    expect(await auth.endSessionsFor(user)).toBe(1);
    expect(await auth.userForSession(session)).toBeNull();
    expect(await auth.userForApiToken(token)).not.toBeNull();
  });

  it("accepts each sign-in nonce once", async () => {
    const auth = await store();
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    expect(await auth.useNonce("nonce-1", expiresAt)).toBe(true);
    expect(await auth.useNonce("nonce-1", expiresAt)).toBe(false);
  });
});
