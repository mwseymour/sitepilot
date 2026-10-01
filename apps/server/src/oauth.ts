import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SqlConnection } from "@sitepilot/sql";
import express from "express";

import { hashToken, randomToken, type AuthStore, type SignedInUser } from "./auth.js";

/**
 * OAuth 2.1 for remote MCP clients such as claude.ai, per the MCP
 * authorization spec. The MCP SDK's router serves the protocol endpoints
 * (metadata, /register, /authorize, /token, /revoke) and checks PKCE; this
 * provider keeps clients, codes and tokens in Postgres, and sends /authorize
 * through Sign in with WordPress and a consent page. Tokens act as the
 * WordPress user who allowed them, with their WordPress role; no scope can
 * approve, apply or publish.
 */

export const OAUTH_SCOPES = ["read", "request", "review"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  read: "Look up posts and pages, and see your requests and conversations",
  request: "Make requests and ask for changes to them",
  review: "See review previews"
};

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 10 * 60;
const PENDING_TTL_SECONDS = 10 * 60;

const ACCESS_PREFIX = "spa_";
const REFRESH_PREFIX = "spr_";

type PendingParams = {
  scopes: OAuthScope[];
  state?: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
};

export type PendingAuthorization = {
  id: string;
  client: OAuthClientInformationFull;
  params: PendingParams;
};

export type ConnectedApp = {
  grantId: string;
  clientName: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
};

export type OAuthCaller = {
  user: SignedInUser;
  scopes: OAuthScope[];
  /** What the audit records as the client: from its registration, not its handshake. */
  clientName: string;
};

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseScopes(value: string): OAuthScope[] {
  return value.split(" ").filter((scope): scope is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(scope));
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The name the audit uses for a client. claude.ai is known by its callback. */
export function clientDisplayName(client: OAuthClientInformationFull): string {
  const hosts = client.redirect_uris.map((uri) => {
    try {
      return new URL(uri).hostname;
    } catch {
      return "";
    }
  });
  if (hosts.some((host) => host === "claude.ai" || host === "claude.com")) return "claude.ai";
  return (client.client_name ?? "").trim().slice(0, 80) || "An MCP app";
}

export class SitePilotOAuthProvider implements OAuthServerProvider {
  readonly #sql: SqlConnection;
  readonly #auth: AuthStore;
  readonly #mcpUrl: URL;

  public constructor(input: { sql: SqlConnection; auth: AuthStore; mcpUrl: URL }) {
    this.#sql = input.sql;
    this.#auth = input.auth;
    this.#mcpUrl = input.mcpUrl;
  }

  public get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        const row = await this.#sql
          .prepare<{ clientId: string }, { clientJson: string }>(
            `SELECT client_json AS "clientJson" FROM oauth_clients WHERE client_id = @clientId`
          )
          .get({ clientId });
        return row ? (JSON.parse(row.clientJson) as OAuthClientInformationFull) : undefined;
      },
      // Open registration, as claude.ai needs: a client gets nothing until a
      // WordPress user signs in and allows it.
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        if (full.redirect_uris.length === 0 || !full.redirect_uris.every((uri) => isAllowedRedirect(String(uri)))) {
          throw new InvalidClientMetadataError("redirect_uris must use https, or http on localhost.");
        }
        await this.#sql
          .prepare(`INSERT INTO oauth_clients (client_id, client_json, created_at) VALUES (@clientId, @clientJson, @now)`)
          .run({ clientId: full.client_id, clientJson: JSON.stringify(full), now: new Date().toISOString() });
        return full;
      }
    };
  }

  /** Holds the checked request, then sends the browser to sign in and consent. */
  public async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: { redirect(status: number, url: string): void }
  ): Promise<void> {
    const requested = params.scopes && params.scopes.length > 0 ? params.scopes : [...OAUTH_SCOPES];
    const unknown = requested.filter((scope) => !(OAUTH_SCOPES as readonly string[]).includes(scope));
    if (unknown.length > 0) throw new InvalidScopeError(`Unknown scope: ${unknown.join(" ")}.`);
    if (params.resource && !this.#isThisResource(params.resource)) {
      throw new InvalidTargetError("This server only issues tokens for its own MCP endpoint.");
    }
    const id = randomToken();
    const pending: PendingParams = {
      scopes: requested as OAuthScope[],
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      ...(params.state !== undefined ? { state: params.state } : {}),
      ...(params.resource ? { resource: params.resource.href } : {})
    };
    await this.#sql
      .prepare(
        `INSERT INTO oauth_pending (id, client_id, params_json, expires_at) VALUES (@id, @clientId, @paramsJson, @expiresAt)`
      )
      .run({ id, clientId: client.client_id, paramsJson: JSON.stringify(pending), expiresAt: isoIn(PENDING_TTL_SECONDS) });
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
  }

  public async pending(id: string): Promise<PendingAuthorization | null> {
    const row = await this.#sql
      .prepare<{ id: string; now: string }, { clientId: string; paramsJson: string }>(
        `SELECT client_id AS "clientId", params_json AS "paramsJson" FROM oauth_pending
         WHERE id = @id AND expires_at > @now`
      )
      .get({ id, now: new Date().toISOString() });
    if (!row) return null;
    const client = await this.clientsStore.getClient(row.clientId);
    return client ? { id, client, params: JSON.parse(row.paramsJson) as PendingParams } : null;
  }

  /** True when this person already allowed this client at least these scopes. */
  public async hasConsent(user: SignedInUser, pending: PendingAuthorization): Promise<boolean> {
    const row = await this.#sql
      .prepare<{ siteId: string; wordpressUserId: number; clientId: string }, { scopes: string }>(
        `SELECT scopes FROM oauth_consents
         WHERE site_id = @siteId AND wordpress_user_id = @wordpressUserId AND client_id = @clientId`
      )
      .get({ siteId: user.siteId, wordpressUserId: user.wordpressUserId, clientId: pending.client.client_id });
    if (!row) return false;
    const allowed = parseScopes(row.scopes);
    return pending.params.scopes.every((scope) => allowed.includes(scope));
  }

  /** Allows the request: remembers consent and returns the client's redirect with a one-use code. */
  public async approve(user: SignedInUser, pending: PendingAuthorization): Promise<string> {
    const code = randomToken();
    const now = new Date().toISOString();
    await this.#sql.transaction(async (tx) => {
      const taken = await tx.prepare(`DELETE FROM oauth_pending WHERE id = @id`).run({ id: pending.id });
      if (taken.changes !== 1) throw new InvalidGrantError("This connection request was already answered.");
      await tx
        .prepare(
          `INSERT INTO oauth_codes (code_hash, client_id, site_id, wordpress_user_id, scopes, code_challenge, redirect_uri, resource, expires_at)
           VALUES (@codeHash, @clientId, @siteId, @wordpressUserId, @scopes, @codeChallenge, @redirectUri, @resource, @expiresAt)`
        )
        .run({
          codeHash: hashToken(code),
          clientId: pending.client.client_id,
          siteId: user.siteId,
          wordpressUserId: user.wordpressUserId,
          scopes: pending.params.scopes.join(" "),
          codeChallenge: pending.params.codeChallenge,
          redirectUri: pending.params.redirectUri,
          resource: pending.params.resource ?? null,
          expiresAt: isoIn(CODE_TTL_SECONDS)
        });
      await tx
        .prepare(
          `INSERT INTO oauth_consents (site_id, wordpress_user_id, client_id, scopes, created_at)
           VALUES (@siteId, @wordpressUserId, @clientId, @scopes, @now)
           ON CONFLICT (site_id, wordpress_user_id, client_id) DO UPDATE SET scopes = @scopes, created_at = @now`
        )
        .run({
          siteId: user.siteId,
          wordpressUserId: user.wordpressUserId,
          clientId: pending.client.client_id,
          scopes: pending.params.scopes.join(" "),
          now
        });
    });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    return target.toString();
  }

  /** Refuses the request: returns the client's redirect with access_denied. */
  public async deny(pending: PendingAuthorization): Promise<string> {
    await this.#sql.prepare(`DELETE FROM oauth_pending WHERE id = @id`).run({ id: pending.id });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The person declined to connect SitePilot.");
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    return target.toString();
  }

  public async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = await this.#sql
      .prepare<{ codeHash: string; clientId: string; now: string }, { codeChallenge: string }>(
        `SELECT code_challenge AS "codeChallenge" FROM oauth_codes
         WHERE code_hash = @codeHash AND client_id = @clientId AND used_at IS NULL AND expires_at > @now`
      )
      .get({ codeHash: hashToken(code), clientId: client.client_id, now: new Date().toISOString() });
    if (!row) throw new InvalidGrantError("The authorization code is unknown, used or expired.");
    return row.codeChallenge;
  }

  public async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.#sql.transaction(async (tx) => {
      const now = new Date().toISOString();
      // Marking it used in the same statement makes the code one-use, even
      // with two exchanges at once.
      const row = await tx
        .prepare<
          { codeHash: string; clientId: string; now: string },
          { siteId: string; wordpressUserId: number; scopes: string; redirectUri: string; resource: string | null }
        >(
          `UPDATE oauth_codes SET used_at = @now
           WHERE code_hash = @codeHash AND client_id = @clientId AND used_at IS NULL AND expires_at > @now
           RETURNING site_id AS "siteId", wordpress_user_id AS "wordpressUserId", scopes,
             redirect_uri AS "redirectUri", resource`
        )
        .get({ codeHash: hashToken(code), clientId: client.client_id, now });
      if (!row) throw new InvalidGrantError("The authorization code is unknown, used or expired.");
      if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
        throw new InvalidGrantError("redirect_uri doesn't match the authorization request.");
      }
      if (resource && row.resource && resource.href !== row.resource) {
        throw new InvalidTargetError("resource doesn't match the authorization request.");
      }
      return this.#issue(tx, {
        grantId: randomUUID(),
        clientId: client.client_id,
        siteId: row.siteId,
        wordpressUserId: Number(row.wordpressUserId),
        scopes: parseScopes(row.scopes),
        resource: row.resource
      });
    });
  }

  public async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = new Date().toISOString();
    const issued = await this.#sql.transaction(async (tx) => {
      // Refresh tokens rotate: each works once.
      const row = await tx
        .prepare<
          { tokenHash: string; clientId: string; now: string },
          { grantId: string; siteId: string; wordpressUserId: number; scopes: string; resource: string | null }
        >(
          `UPDATE oauth_tokens SET used_at = @now
           WHERE token_hash = @tokenHash AND kind = 'refresh' AND client_id = @clientId
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > @now
           RETURNING grant_id AS "grantId", site_id AS "siteId", wordpress_user_id AS "wordpressUserId", scopes, resource`
        )
        .get({ tokenHash, clientId: client.client_id, now });
      if (!row) return null;
      const granted = parseScopes(row.scopes);
      const narrowed = scopes && scopes.length > 0 ? scopes : granted;
      if (!narrowed.every((scope) => (granted as string[]).includes(scope))) {
        throw new InvalidScopeError("A refresh can't add scopes.");
      }
      if (resource && row.resource && resource.href !== row.resource) {
        throw new InvalidTargetError("resource doesn't match the original grant.");
      }
      return this.#issue(tx, {
        grantId: row.grantId,
        clientId: client.client_id,
        siteId: row.siteId,
        wordpressUserId: Number(row.wordpressUserId),
        scopes: narrowed as OAuthScope[],
        resource: row.resource
      });
    });
    if (issued) return issued;
    // A used refresh token coming back means it may have been copied: end
    // the whole grant, so neither copy keeps working.
    const reused = await this.#sql
      .prepare<{ tokenHash: string }, { grantId: string }>(
        `SELECT grant_id AS "grantId" FROM oauth_tokens WHERE token_hash = @tokenHash AND kind = 'refresh' AND used_at IS NOT NULL`
      )
      .get({ tokenHash });
    if (reused) await this.#revokeGrant(reused.grantId);
    throw new InvalidGrantError("The refresh token is unknown, used, revoked or expired.");
  }

  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await this.#sql
      .prepare<
        { tokenHash: string; now: string },
        { clientId: string; scopes: string; expiresAt: string; resource: string | null; siteId: string; wordpressUserId: number }
      >(
        `SELECT client_id AS "clientId", scopes, expires_at AS "expiresAt", resource,
           site_id AS "siteId", wordpress_user_id AS "wordpressUserId"
         FROM oauth_tokens
         WHERE token_hash = @tokenHash AND kind = 'access' AND revoked_at IS NULL AND expires_at > @now`
      )
      .get({ tokenHash: hashToken(token), now: new Date().toISOString() });
    if (!row) throw new InvalidTokenError("The access token is unknown, revoked or expired.");
    return {
      token,
      clientId: row.clientId,
      scopes: parseScopes(row.scopes),
      expiresAt: Math.floor(new Date(row.expiresAt).getTime() / 1000),
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
      extra: { siteId: row.siteId, wordpressUserId: Number(row.wordpressUserId) }
    };
  }

  public async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = await this.#sql
      .prepare<{ tokenHash: string; clientId: string }, { grantId: string }>(
        `SELECT grant_id AS "grantId" FROM oauth_tokens WHERE token_hash = @tokenHash AND client_id = @clientId`
      )
      .get({ tokenHash: hashToken(request.token), clientId: client.client_id });
    if (row) await this.#revokeGrant(row.grantId);
  }

  /** The person and scopes behind an OAuth access token, for /mcp. */
  public async callerForAccessToken(token: string): Promise<OAuthCaller | null> {
    if (!token.startsWith(ACCESS_PREFIX)) return null;
    let info: AuthInfo;
    try {
      info = await this.verifyAccessToken(token);
    } catch {
      return null;
    }
    if (info.resource && !this.#isThisResource(info.resource)) return null;
    const extra = info.extra as { siteId: string; wordpressUserId: number };
    const [user, client] = await Promise.all([
      this.#auth.userFor(extra.siteId, extra.wordpressUserId),
      this.clientsStore.getClient(info.clientId)
    ]);
    if (!user || !client) return null;
    await this.#sql
      .prepare(`UPDATE oauth_tokens SET used_at = @now WHERE token_hash = @tokenHash`)
      .run({ tokenHash: hashToken(token), now: new Date().toISOString() });
    return { user, scopes: info.scopes as OAuthScope[], clientName: clientDisplayName(client) };
  }

  /** Apps this person has connected, for the account page. */
  public async connectedApps(user: SignedInUser): Promise<ConnectedApp[]> {
    const rows = await this.#sql
      .prepare<
        { siteId: string; wordpressUserId: number; now: string },
        { grantId: string; clientId: string; scopes: string; connectedAt: string; lastUsedAt: string | null }
      >(
        `SELECT grant_id AS "grantId", MIN(client_id) AS "clientId", MAX(scopes) AS scopes,
           MIN(created_at) AS "connectedAt", MAX(CASE WHEN kind = 'access' THEN used_at END) AS "lastUsedAt"
         FROM oauth_tokens
         WHERE site_id = @siteId AND wordpress_user_id = @wordpressUserId AND revoked_at IS NULL AND expires_at > @now
         GROUP BY grant_id ORDER BY MIN(created_at) DESC`
      )
      .all({ siteId: user.siteId, wordpressUserId: user.wordpressUserId, now: new Date().toISOString() });
    const apps: ConnectedApp[] = [];
    for (const row of rows) {
      const client = await this.clientsStore.getClient(row.clientId);
      apps.push({
        grantId: row.grantId,
        clientName: client ? clientDisplayName(client) : "An MCP app",
        scopes: parseScopes(row.scopes),
        connectedAt: row.connectedAt,
        lastUsedAt: row.lastUsedAt
      });
    }
    return apps;
  }

  /** Disconnects an app: ends its tokens and forgets the consent, so it asks again. */
  public async disconnect(user: SignedInUser, grantId: string): Promise<void> {
    const row = await this.#sql
      .prepare<{ grantId: string; siteId: string; wordpressUserId: number }, { clientId: string }>(
        `SELECT client_id AS "clientId" FROM oauth_tokens
         WHERE grant_id = @grantId AND site_id = @siteId AND wordpress_user_id = @wordpressUserId LIMIT 1`
      )
      .get({ grantId, siteId: user.siteId, wordpressUserId: user.wordpressUserId });
    if (!row) return;
    await this.#revokeGrant(grantId);
    await this.#sql
      .prepare(
        `DELETE FROM oauth_consents WHERE site_id = @siteId AND wordpress_user_id = @wordpressUserId AND client_id = @clientId`
      )
      .run({ siteId: user.siteId, wordpressUserId: user.wordpressUserId, clientId: row.clientId });
  }

  async #revokeGrant(grantId: string): Promise<void> {
    await this.#sql
      .prepare(`UPDATE oauth_tokens SET revoked_at = @now WHERE grant_id = @grantId AND revoked_at IS NULL`)
      .run({ grantId, now: new Date().toISOString() });
  }

  async #issue(
    tx: SqlConnection,
    input: {
      grantId: string;
      clientId: string;
      siteId: string;
      wordpressUserId: number;
      scopes: OAuthScope[];
      resource: string | null;
    }
  ): Promise<OAuthTokens> {
    const accessToken = randomToken(ACCESS_PREFIX);
    const refreshToken = randomToken(REFRESH_PREFIX);
    const now = new Date().toISOString();
    const insert = tx.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, site_id, wordpress_user_id, scopes, resource, created_at, expires_at)
       VALUES (@tokenHash, @kind, @grantId, @clientId, @siteId, @wordpressUserId, @scopes, @resource, @now, @expiresAt)`
    );
    const common = {
      grantId: input.grantId,
      clientId: input.clientId,
      siteId: input.siteId,
      wordpressUserId: input.wordpressUserId,
      scopes: input.scopes.join(" "),
      resource: input.resource,
      now
    };
    await insert.run({ ...common, tokenHash: hashToken(accessToken), kind: "access", expiresAt: isoIn(ACCESS_TTL_SECONDS) });
    await insert.run({ ...common, tokenHash: hashToken(refreshToken), kind: "refresh", expiresAt: isoIn(REFRESH_TTL_SECONDS) });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: input.scopes.join(" ")
    };
  }

  #isThisResource(resource: URL): boolean {
    const strip = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return strip(resource) === strip(this.#mcpUrl);
  }
}

/** Paths the SDK's OAuth router answers. */
export function isOAuthPath(path: string): boolean {
  return (
    path === "/authorize" ||
    path === "/token" ||
    path === "/register" ||
    path === "/revoke" ||
    path.startsWith("/.well-known/oauth-")
  );
}

/** The SDK's OAuth endpoints, as a plain node:http handler. */
export function createOAuthEndpoints(input: { provider: SitePilotOAuthProvider; publicUrl: URL; mcpUrl: URL }) {
  const app = express();
  // Railway's proxy sets X-Forwarded-For; the router's rate limits read it.
  app.set("trust proxy", 1);
  app.use(
    mcpAuthRouter({
      provider: input.provider,
      issuerUrl: new URL(input.publicUrl.origin),
      resourceServerUrl: input.mcpUrl,
      scopesSupported: [...OAUTH_SCOPES],
      resourceName: "SitePilot"
    })
  );
  return function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Some clients look for the protected resource metadata without the path.
    if (request.url === "/.well-known/oauth-protected-resource") {
      request.url = `/.well-known/oauth-protected-resource${input.mcpUrl.pathname}`;
    }
    return new Promise((resolve) => {
      response.on("close", resolve);
      app(request as express.Request, response as express.Response, () => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
    });
  };
}
