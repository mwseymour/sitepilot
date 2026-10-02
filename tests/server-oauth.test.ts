import { afterEach, describe, expect, it } from "vitest";

import { seedDefaultWorkspace } from "../packages/core/src/app-database.js";
import { initializePostgresDatabase } from "@sitepilot/repositories";

import { AuthStore, type SignInAssertion } from "../apps/server/src/auth.js";
import { SitePilotOAuthProvider, clientDisplayName } from "../apps/server/src/oauth.js";
import {
  TEST_POSTGRES_URL,
  createTestPostgresDatabase
} from "./postgres-test-database.js";

/** The hosted OAuth provider: one-use codes, rotating refresh tokens, consent and scopes. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MCP_URL = new URL("https://sitepilot.example/mcp");

const assertion = {
  siteId: "site-1",
  state: "state-abcdefghijklmnop",
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: 1_790_000_120,
  user: { id: 42, login: "ann", email: "ann@example.com", displayName: "Ann Editor" },
  capabilities: { edit_posts: true, publish_posts: true }
} as unknown as SignInAssertion;

async function setup() {
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
  const auth = new AuthStore(database.sql);
  const user = await auth.linkIdentity({ assertion, workspaceId: "workspace-1" });
  const provider = new SitePilotOAuthProvider({ sql: database.sql, auth, mcpUrl: MCP_URL });
  const client = await provider.clientsStore.registerClient!({
    client_id: "client-1",
    client_id_issued_at: 1_790_000_000,
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none"
  } as never);
  return { provider, user: user!, client, sql: database.sql };
}

/** Starts an authorization and returns the pending request it created. */
async function authorize(
  provider: SitePilotOAuthProvider,
  client: Awaited<ReturnType<typeof setup>>["client"],
  scopes: string[] = []
) {
  let location = "";
  await provider.authorize(
    client,
    {
      scopes,
      state: "client-state",
      codeChallenge: "challenge-abc",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      resource: MCP_URL
    },
    { redirect: (_status, url) => (location = url) }
  );
  const id = /^\/oauth\/consent\?request=([A-Za-z0-9_-]+)$/.exec(location)?.[1];
  const pending = id ? await provider.pending(id) : null;
  if (!pending) throw new Error(`No pending authorization from ${location}`);
  return pending;
}

function codeFrom(redirect: string): string {
  const url = new URL(redirect);
  expect(url.origin + url.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
  expect(url.searchParams.get("state")).toBe("client-state");
  return url.searchParams.get("code") ?? "";
}

describe.skipIf(!TEST_POSTGRES_URL)("hosted OAuth", () => {
  it("issues tokens for an allowed request, once per code, as the WordPress user", async () => {
    const { provider, user, client, sql } = await setup();
    expect(clientDisplayName(client)).toBe("claude.ai");

    const pending = await authorize(provider, client);
    expect(pending.params.scopes).toEqual(["read", "request", "review", "approve"]);
    expect(await provider.hasConsent(user, pending)).toBe(false);
    const code = codeFrom(await provider.approve(user, pending));
    // The pending request is answered once.
    await expect(provider.approve(user, pending)).rejects.toThrow();

    expect(await provider.challengeForAuthorizationCode(client, code)).toBe("challenge-abc");
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, pending.params.redirectUri, MCP_URL);
    expect(tokens).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "read request review approve" });
    expect(tokens.access_token).toMatch(/^spa_/);
    expect(tokens.refresh_token).toMatch(/^spr_/);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/unknown, used or expired/);

    const caller = await provider.callerForAccessToken(tokens.access_token);
    expect(caller).toMatchObject({
      user: { userProfileId: user.userProfileId },
      scopes: ["read", "request", "review", "approve"],
      clientName: "claude.ai"
    });
    expect(await provider.callerForAccessToken("spa_not-a-real-token")).toBeNull();

    // Consent is remembered for these scopes, and the app shows on the account page.
    expect(await provider.hasConsent(user, await authorize(provider, client, ["read"]))).toBe(true);
    const [app] = await provider.connectedApps(user);
    expect(app).toMatchObject({ clientName: "claude.ai", scopes: ["read", "request", "review", "approve"] });
    expect(app?.lastUsedAt).not.toBeNull();
    // Access tokens last an hour; the app still shows when it was last used.
    await sql.prepare(`UPDATE oauth_tokens SET expires_at = @past WHERE kind = 'access'`).run({ past: "2026-01-01T00:00:00.000Z" });
    const [later] = await provider.connectedApps(user);
    expect(later).toMatchObject({ grantId: app!.grantId, lastUsedAt: app!.lastUsedAt, scopes: ["read", "request", "review", "approve"] });
  });

  it("never grants approve to someone who can't publish", async () => {
    const { provider, user, client } = await setup();
    const contributor = { ...user, siteRoles: ["request", "edit_drafts"] as typeof user.siteRoles };
    const pending = await authorize(provider, client);
    expect(provider.grantableScopes(contributor, pending)).toEqual(["read", "request", "review"]);
    const tokens = await provider.exchangeAuthorizationCode(client, codeFrom(await provider.approve(contributor, pending)));
    expect(tokens.scope).toBe("read request review");
  });

  it("rotates refresh tokens, and ends the grant when a used one comes back", async () => {
    const { provider, user, client } = await setup();
    const pending = await authorize(provider, client);
    const first = await provider.exchangeAuthorizationCode(client, codeFrom(await provider.approve(user, pending)));

    const second = await provider.exchangeRefreshToken(client, first.refresh_token!, ["read"]);
    expect(second.scope).toBe("read");
    await expect(provider.exchangeRefreshToken(client, second.refresh_token!, ["read", "request"])).rejects.toThrow(/can't add scopes/);
    const third = await provider.exchangeRefreshToken(client, second.refresh_token!);
    expect(await provider.callerForAccessToken(third.access_token)).not.toBeNull();

    // The first refresh token was already used: replaying it revokes everything in the grant.
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow();
    expect(await provider.callerForAccessToken(third.access_token)).toBeNull();
    await expect(provider.exchangeRefreshToken(client, third.refresh_token!)).rejects.toThrow();
  });

  it("revokes and disconnects, and refuses bad scopes, resources and redirects", async () => {
    const { provider, user, client } = await setup();
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      codeFrom(await provider.approve(user, await authorize(provider, client)))
    );
    await provider.revokeToken(client, { token: tokens.refresh_token! });
    expect(await provider.callerForAccessToken(tokens.access_token)).toBeNull();

    const again = await provider.exchangeAuthorizationCode(
      client,
      codeFrom(await provider.approve(user, await authorize(provider, client)))
    );
    const [app] = await provider.connectedApps(user);
    await provider.disconnect(user, app!.grantId);
    expect(await provider.callerForAccessToken(again.access_token)).toBeNull();
    // Disconnecting forgets the consent, so the next connection asks again.
    expect(await provider.hasConsent(user, await authorize(provider, client))).toBe(false);

    await expect(authorize(provider, client, ["read", "admin"])).rejects.toThrow(/Unknown scope/);
    await expect(
      provider.authorize(
        client,
        { codeChallenge: "c", redirectUri: client.redirect_uris[0]!, resource: new URL("https://elsewhere.example/mcp") },
        { redirect: () => undefined }
      )
    ).rejects.toThrow(/its own MCP endpoint/);
    await expect(
      provider.clientsStore.registerClient!({
        client_id: "client-2",
        redirect_uris: ["http://evil.example/callback"]
      } as never)
    ).rejects.toThrow(/https/);
    await expect(
      provider.clientsStore.registerClient!({
        client_id: "client-3",
        client_name: "Claude Code",
        redirect_uris: ["http://localhost:33418/callback"]
      } as never)
    ).resolves.toMatchObject({ client_id: "client-3" });
  });
});
