import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import type { AppRole, SiteRole } from "@sitepilot/domain";
import type { SqlConnection } from "@sitepilot/sql";

/**
 * Sign in with WordPress (MCP plan 6.1). The plugin sends back a short-lived
 * assertion of who signed in, signed with the site's shared secret; the
 * server checks it, links the WordPress user and gives them a session.
 * Roles come from WordPress capabilities on every sign-in.
 */

export const SIGN_IN_SCHEMA = "sitepilot.wordpress-sign-in/v1";
export const SESSION_COOKIE = "sp_session";
export const STATE_COOKIE = "sp_sign_in";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const STATE_TTL_SECONDS = 10 * 60;

export type SignInAssertion = {
  siteId: string;
  state: string;
  nonce: string;
  expiresAt: number;
  user: { id: number; login: string; email: string; displayName: string };
  capabilities: Record<string, boolean>;
};

export type SignedInUser = {
  siteId: string;
  wordpressUserId: number;
  userProfileId: string;
  login: string;
  email: string | null;
  displayName: string;
  appRole: AppRole;
  siteRoles: SiteRole[];
};

/** People who can publish can approve; other editors can request. */
export function rolesFromCapabilities(
  capabilities: Record<string, boolean>
): { appRole: AppRole; siteRoles: SiteRole[] } {
  if (capabilities.manage_options) {
    return {
      appRole: "admin",
      siteRoles: ["request", "edit_drafts", "approve", "publish", "manage_config", "manage_connection"]
    };
  }
  if (capabilities.publish_posts) {
    return { appRole: "approver", siteRoles: ["request", "edit_drafts", "approve", "publish"] };
  }
  if (capabilities.edit_posts) {
    return { appRole: "requester", siteRoles: ["request", "edit_drafts"] };
  }
  return { appRole: "read_only_auditor", siteRoles: ["audit_only"] };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function randomToken(prefix = ""): string {
  return `${prefix}${base64url(randomBytes(32))}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Checks the plugin's signature and the assertion's shape and expiry. */
export function verifySignInAssertion(input: {
  payload: string;
  signature: string;
  sharedSecret: Buffer;
  nowSeconds: number;
}): { ok: true; assertion: SignInAssertion } | { ok: false; reason: string } {
  const expected = createHmac("sha256", input.sharedSecret)
    .update(`${SIGN_IN_SCHEMA}\n${input.payload}`)
    .digest();
  const given = Buffer.from(input.signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature_invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input.payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "payload_invalid" };
  }
  const value = parsed as Partial<SignInAssertion> & { schema?: unknown };
  const user = value.user as Partial<SignInAssertion["user"]> | undefined;
  if (
    value.schema !== SIGN_IN_SCHEMA ||
    typeof value.siteId !== "string" ||
    typeof value.state !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.expiresAt !== "number" ||
    typeof user?.id !== "number" ||
    typeof user.login !== "string" ||
    typeof user.displayName !== "string" ||
    value.capabilities === null ||
    typeof value.capabilities !== "object"
  ) {
    return { ok: false, reason: "payload_invalid" };
  }
  if (value.expiresAt < input.nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, assertion: value as SignInAssertion };
}

type IdentityRow = {
  siteId: string;
  wordpressUserId: number;
  userProfileId: string;
  login: string;
  email: string | null;
  displayName: string;
  appRole: AppRole;
  siteRolesJson: string;
};

const IDENTITY_COLUMNS = `i.site_id AS "siteId", i.wordpress_user_id AS "wordpressUserId",
  i.user_profile_id AS "userProfileId", i.login, i.email, i.display_name AS "displayName",
  i.app_role AS "appRole", i.site_roles_json AS "siteRolesJson"`;

function toUser(row: IdentityRow): SignedInUser {
  return {
    siteId: row.siteId,
    wordpressUserId: Number(row.wordpressUserId),
    userProfileId: row.userProfileId,
    login: row.login,
    email: row.email,
    displayName: row.displayName,
    appRole: row.appRole,
    siteRoles: JSON.parse(row.siteRolesJson) as SiteRole[]
  };
}

export type ApiTokenSummary = {
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** Identities, sessions and MCP tokens in the hosted database. */
export class AuthStore {
  public constructor(private readonly sql: SqlConnection) {}

  /** False when the nonce was already used: a replayed assertion. */
  public async useNonce(nonce: string, expiresAtSeconds: number): Promise<boolean> {
    const now = new Date().toISOString();
    await this.sql.prepare(`DELETE FROM used_sign_in_nonces WHERE expires_at < @now`).run({ now });
    const result = await this.sql
      .prepare(
        `INSERT INTO used_sign_in_nonces (nonce, expires_at) VALUES (@nonce, @expiresAt)
         ON CONFLICT (nonce) DO NOTHING`
      )
      .run({ nonce, expiresAt: new Date(expiresAtSeconds * 1000).toISOString() });
    return result.changes === 1;
  }

  /** Links the WordPress user, refreshing their name and role. */
  public async linkIdentity(input: {
    assertion: SignInAssertion;
    workspaceId: string;
  }): Promise<SignedInUser> {
    const { assertion } = input;
    const roles = rolesFromCapabilities(assertion.capabilities);
    const userProfileId = `wp-${assertion.siteId}-${assertion.user.id}`;
    const now = new Date().toISOString();
    await this.sql.transaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO user_profiles (id, workspace_id, display_name, email, app_role, created_at, updated_at)
           VALUES (@id, @workspaceId, @displayName, @email, @appRole, @now, @now)
           ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name,
             email = excluded.email, app_role = excluded.app_role, updated_at = excluded.updated_at`
        )
        .run({
          id: userProfileId,
          workspaceId: input.workspaceId,
          displayName: assertion.user.displayName,
          email: assertion.user.email || null,
          appRole: roles.appRole,
          now
        });
      await tx
        .prepare(
          `INSERT INTO wordpress_identities (site_id, wordpress_user_id, user_profile_id, login, email,
             display_name, app_role, site_roles_json, last_sign_in_at, created_at, updated_at)
           VALUES (@siteId, @wordpressUserId, @userProfileId, @login, @email, @displayName,
             @appRole, @siteRolesJson, @now, @now, @now)
           ON CONFLICT (site_id, wordpress_user_id) DO UPDATE SET login = excluded.login,
             email = excluded.email, display_name = excluded.display_name, app_role = excluded.app_role,
             site_roles_json = excluded.site_roles_json, last_sign_in_at = excluded.last_sign_in_at,
             updated_at = excluded.updated_at`
        )
        .run({
          siteId: assertion.siteId,
          wordpressUserId: assertion.user.id,
          userProfileId,
          login: assertion.user.login,
          email: assertion.user.email || null,
          displayName: assertion.user.displayName,
          appRole: roles.appRole,
          siteRolesJson: JSON.stringify(roles.siteRoles),
          now
        });
    });
    return {
      siteId: assertion.siteId,
      wordpressUserId: assertion.user.id,
      userProfileId,
      login: assertion.user.login,
      email: assertion.user.email || null,
      displayName: assertion.user.displayName,
      ...roles
    };
  }

  public async createSession(user: SignedInUser): Promise<string> {
    const token = randomToken();
    const now = Date.now();
    await this.sql
      .prepare(
        `INSERT INTO web_sessions (token_hash, site_id, wordpress_user_id, created_at, expires_at)
         VALUES (@tokenHash, @siteId, @wordpressUserId, @createdAt, @expiresAt)`
      )
      .run({
        tokenHash: hashToken(token),
        siteId: user.siteId,
        wordpressUserId: user.wordpressUserId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString()
      });
    return token;
  }

  public async userForSession(token: string | undefined): Promise<SignedInUser | null> {
    if (!token) return null;
    const row = await this.sql
      .prepare<{ tokenHash: string; now: string }, IdentityRow>(
        `SELECT ${IDENTITY_COLUMNS} FROM web_sessions s
         JOIN wordpress_identities i ON i.site_id = s.site_id AND i.wordpress_user_id = s.wordpress_user_id
         WHERE s.token_hash = @tokenHash AND s.expires_at > @now`
      )
      .get({ tokenHash: hashToken(token), now: new Date().toISOString() });
    return row ? toUser(row) : null;
  }

  public async endSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.sql
      .prepare(`DELETE FROM web_sessions WHERE token_hash = @tokenHash`)
      .run({ tokenHash: hashToken(token) });
  }

  /** A personal MCP token; only its hash is kept, so it's shown once. */
  public async createApiToken(user: SignedInUser, label: string): Promise<string> {
    const token = randomToken("spt_");
    await this.sql
      .prepare(
        `INSERT INTO api_tokens (token_hash, site_id, wordpress_user_id, label, created_at)
         VALUES (@tokenHash, @siteId, @wordpressUserId, @label, @now)`
      )
      .run({
        tokenHash: hashToken(token),
        siteId: user.siteId,
        wordpressUserId: user.wordpressUserId,
        label: label.slice(0, 80) || "MCP client",
        now: new Date().toISOString()
      });
    return token;
  }

  public async userForApiToken(token: string): Promise<SignedInUser | null> {
    const tokenHash = hashToken(token);
    const row = await this.sql
      .prepare<{ tokenHash: string }, IdentityRow>(
        `SELECT ${IDENTITY_COLUMNS} FROM api_tokens t
         JOIN wordpress_identities i ON i.site_id = t.site_id AND i.wordpress_user_id = t.wordpress_user_id
         WHERE t.token_hash = @tokenHash AND t.revoked_at IS NULL`
      )
      .get({ tokenHash });
    if (!row) return null;
    await this.sql
      .prepare(`UPDATE api_tokens SET last_used_at = @now WHERE token_hash = @tokenHash`)
      .run({ tokenHash, now: new Date().toISOString() });
    return toUser(row);
  }

  public async listApiTokens(user: SignedInUser): Promise<ApiTokenSummary[]> {
    return this.sql
      .prepare<{ siteId: string; wordpressUserId: number }, ApiTokenSummary>(
        `SELECT token_hash AS "tokenHash", label, created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM api_tokens WHERE site_id = @siteId AND wordpress_user_id = @wordpressUserId
           AND revoked_at IS NULL ORDER BY created_at DESC`
      )
      .all({ siteId: user.siteId, wordpressUserId: user.wordpressUserId });
  }

  public async revokeApiToken(user: SignedInUser, tokenHash: string): Promise<void> {
    await this.sql
      .prepare(
        `UPDATE api_tokens SET revoked_at = @now WHERE token_hash = @tokenHash
           AND site_id = @siteId AND wordpress_user_id = @wordpressUserId`
      )
      .run({
        tokenHash,
        siteId: user.siteId,
        wordpressUserId: user.wordpressUserId,
        now: new Date().toISOString()
      });
  }
}
