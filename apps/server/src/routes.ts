import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getDatabase } from "@sitepilot/core/app-database";
import { getSecureStorage } from "@sitepilot/core/app-secure-storage";
import { runWithCallContext } from "@sitepilot/core/call-context";
import { refreshDiscoveryForSite } from "@sitepilot/core/discovery-service";
import { registerSiteWithWordPress } from "@sitepilot/core/register-site";
import { generateAndPersistSiteConfigDraft } from "@sitepilot/core/site-config-draft";
import { confirmSiteConfigActivation } from "@sitepilot/core/site-workspace-service";
import type { SiteConfigId, SiteId } from "@sitepilot/domain";
import { HOSTED_APP_CLIENT_NAME, type SitePilotMcpBackend } from "@sitepilot/mcp-server";

import type { AppShell } from "./app-shell.js";
import {
  type AuthStore,
  isRoleOverride,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  verifySignInAssertion,
  type Person,
  type PersonRef,
  type SignedInUser
} from "./auth.js";
import {
  cookie,
  isSameOrigin,
  parseCookies,
  readForm,
  redirect,
  send,
  sendHtml
} from "./http.js";
import { clientDisplayName, isOAuthPath, type SitePilotOAuthProvider } from "./oauth.js";
import type { ReviewLinks } from "./review-links.js";
import { structureDiffText } from "./structure-diff.js";
import type { SlackApp } from "./slack.js";
import {
  accountPage,
  connectPage,
  consentPage,
  homePage,
  layout,
  messagePage,
  peoplePage
} from "./pages.js";

/** The hosted app's pages and sign-in, over the shared SitePilot services. */

export type RoutesDependencies = {
  publicUrl: URL;
  /**
   * The one site this deployment may connect (SITEPILOT_SITE_URL). Without
   * it, connecting is off: otherwise anyone could connect their own site and
   * use this deployment's planner and worker.
   */
  allowedSiteUrl: URL | null;
  auth: AuthStore;
  backend: SitePilotMcpBackend;
  mcp: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /** The desktop app's interface, when its build is present. */
  app?: AppShell;
  /** Signed preview links that open without signing in (review-links.ts). */
  reviewLinks?: ReviewLinks;
  /** The Slack app (slack.ts). */
  slack?: SlackApp;
  /** OAuth 2.1 for remote MCP clients (oauth.ts). */
  oauth?: {
    provider: SitePilotOAuthProvider;
    endpoints: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  };
};

/** Where sign-in returns to, when it isn't the app: the OAuth consent page and Slack's connect page. */
const RETURN_COOKIE = "sp_return";
const RETURN_PATH = /^\/(?:oauth\/consent\?request=[A-Za-z0-9_-]+|slack\/connect\?token=[A-Za-z0-9_.-]+)$/;

const WORKSPACE_ID = "workspace-1";

/** The logo files at the root, where browsers and claude.ai look for a favicon. */
const BRAND_FILES = new Set(["/favicon.ico", "/sitepilot-mark.svg", "/apple-touch-icon.png"]);

/** The connected site. One site per deployment, as the build spec says. */
async function connectedSite() {
  const sites = await getDatabase().repositories.sites.listByWorkspaceId(
    WORKSPACE_ID as never
  );
  return sites[0] ?? null;
}

function asHostedUser<T>(user: SignedInUser, work: () => Promise<T>): Promise<T> {
  return runWithCallContext(
    {
      actor: { userProfileId: user.userProfileId as never, appRole: user.appRole, siteRoles: user.siteRoles },
      source: "hosted_app"
    },
    work
  );
}

export function createRoutes(deps: RoutesDependencies) {
  const secure = deps.publicUrl.protocol === "https:";
  const callbackUrl = new URL("/auth/wordpress/callback", deps.publicUrl).toString();

  const sessionCookie = (value: string, maxAgeSeconds: number) =>
    cookie(SESSION_COOKIE, value, { maxAgeSeconds, secure });

  async function currentUser(request: IncomingMessage): Promise<SignedInUser | null> {
    return deps.auth.userForSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  }

  /** Signed in, or sent to sign in (and back, for a link worth returning to). */
  async function requireUser(request: IncomingMessage, response: ServerResponse) {
    const user = await currentUser(request);
    if (!user) {
      const path = request.url ?? "/";
      redirect(response, RETURN_PATH.test(path) ? `/auth/wordpress/start?return=${encodeURIComponent(path)}` : "/");
    }
    return user;
  }

  function refuse(response: ServerResponse, user: SignedInUser | null, message: string, status = 403) {
    sendHtml(response, status, messagePage("Not allowed", message, user));
  }

  async function home(request: IncomingMessage, response: ServerResponse) {
    const user = await currentUser(request);
    if (user) {
      if (deps.app?.available) return void deps.app.serveFile(response, "/");
      return sendHtml(
        response,
        503,
        messagePage(
          "SitePilot isn't fully installed",
          "This server was built without the app's interface. Rebuild it with npm run build:renderer -w @sitepilot/desktop.",
          user
        )
      );
    }
    const site = await connectedSite();
    sendHtml(response, 200, homePage({ siteName: site?.name ?? null }));
  }

  async function startSignIn(response: ServerResponse, url: URL) {
    const site = await connectedSite();
    if (!site) return redirect(response, "/");
    const returnTo = url.searchParams.get("return") ?? "";
    const state = randomBytes(24).toString("base64url");
    const target = new URL("/wp-admin/admin-post.php", site.baseUrl);
    target.searchParams.set("action", "sitepilot_sign_in");
    target.searchParams.set("site_id", site.id);
    target.searchParams.set("state", state);
    redirect(response, target.toString(), [
      cookie(STATE_COOKIE, `${state}.${site.id}`, { maxAgeSeconds: STATE_TTL_SECONDS, secure }),
      cookie(RETURN_COOKIE, RETURN_PATH.test(returnTo) ? encodeURIComponent(returnTo) : "", {
        maxAgeSeconds: RETURN_PATH.test(returnTo) ? STATE_TTL_SECONDS : 0,
        secure
      })
    ]);
  }

  async function finishSignIn(request: IncomingMessage, response: ServerResponse, url: URL) {
    const clearState = cookie(STATE_COOKIE, "", { maxAgeSeconds: 0, secure });
    const [state, siteId] = (parseCookies(request.headers.cookie)[STATE_COOKIE] ?? "").split(".");
    if (url.searchParams.get("error")) {
      return sendHtml(response, 200, messagePage("Signed out", "Sign-in was cancelled."), [clearState]);
    }
    const payload = url.searchParams.get("assertion") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    const site = await connectedSite();
    const fail = (reason: string) =>
      sendHtml(response, 400, messagePage("Sign-in failed", `${reason} Start again from SitePilot.`), [clearState]);
    if (!state || !siteId || !site || site.id !== siteId) return fail("This sign-in wasn't started here, or it took too long.");
    const sharedSecret = await getSecureStorage().get({ namespace: "site", keyId: site.id });
    if (!sharedSecret) return fail("SitePilot has lost this site's connection secret.");
    const verified = verifySignInAssertion({
      payload,
      signature,
      sharedSecret: Buffer.from(sharedSecret, "base64"),
      nowSeconds: Math.floor(Date.now() / 1000)
    });
    if (!verified.ok) return fail(`WordPress's answer didn't check out (${verified.reason}).`);
    const { assertion } = verified;
    if (assertion.siteId !== site.id || assertion.state !== state) {
      return fail("WordPress's answer was for a different sign-in.");
    }
    if (!(await deps.auth.useNonce(assertion.nonce, assertion.expiresAt))) {
      return fail("That sign-in link was already used.");
    }
    const user = await deps.auth.linkIdentity({ assertion, workspaceId: site.workspaceId });
    if (!user) {
      return sendHtml(
        response,
        403,
        messagePage("No access", "A site admin has turned SitePilot off for your account. Ask them to turn it back on."),
        [clearState, cookie(RETURN_COOKIE, "", { maxAgeSeconds: 0, secure })]
      );
    }
    const token = await deps.auth.createSession(user);
    const returnTo = decodeURIComponent(parseCookies(request.headers.cookie)[RETURN_COOKIE] ?? "");
    redirect(response, RETURN_PATH.test(returnTo) ? returnTo : "/", [
      clearState,
      cookie(RETURN_COOKIE, "", { maxAgeSeconds: 0, secure }),
      sessionCookie(token, SESSION_TTL_SECONDS)
    ]);
  }

  async function connectSite(request: IncomingMessage, response: ServerResponse, user: SignedInUser | null) {
    // Connecting needs the site's registration code, which only its
    // administrators can see. A deployment manages one site.
    if (await connectedSite()) {
      return refuse(response, user, "This deployment manages one site, and one is already connected.");
    }
    if (!deps.allowedSiteUrl) {
      return refuse(response, user, "Connecting is off. Set SITEPILOT_SITE_URL to the site this deployment manages.");
    }
    if (request.method === "GET") {
      return sendHtml(response, 200, connectPage({ values: { siteUrl: deps.allowedSiteUrl.toString() } }));
    }
    const form = await readForm(request);
    const values = {
      siteUrl: (form.get("siteUrl") ?? "").trim(),
      wordpressUsername: (form.get("wordpressUsername") ?? "").trim()
    };
    const again = (error: string) => sendHtml(response, 400, connectPage({ error, values }));
    let siteUrl: URL;
    try {
      siteUrl = new URL(values.siteUrl);
    } catch {
      return again("Enter the site's full address, starting with https://.");
    }
    if (siteUrl.origin !== deps.allowedSiteUrl.origin) {
      return again(`This deployment only manages ${deps.allowedSiteUrl.origin}.`);
    }
    const result = await runWithCallContext(
      {
        actor: { userProfileId: "user-profile-default" as never, appRole: "owner", siteRoles: ["manage_connection", "manage_config"] },
        source: "hosted_app"
      },
      async () => {
        const registered = await registerSiteWithWordPress({
          baseUrl: siteUrl.toString(),
          registrationCode: (form.get("registrationCode") ?? "").trim(),
          siteName: siteUrl.hostname,
          wordpressUsername: values.wordpressUsername,
          trustedAppOrigin: deps.publicUrl.origin,
          signInCallbackUrl: callbackUrl
        });
        if (!registered.ok) return registered;
        const siteId = registered.site.id as SiteId;
        const discovery = await refreshDiscoveryForSite(siteId);
        if (!discovery.ok) return discovery;
        const draft = await generateAndPersistSiteConfigDraft(siteId);
        if (!draft.ok) return draft;
        return confirmSiteConfigActivation(siteId, draft.siteConfig.id as SiteConfigId);
      }
    );
    if (!result.ok) return again(result.message);
    sendHtml(
      response,
      200,
      messagePage("Site connected", "SitePilot is connected. Sign in with your WordPress account to start.")
    );
  }

  /** An app asking to connect: sign in first, then allow or not (remembered per app). */
  async function consent(request: IncomingMessage, response: ServerResponse, url: URL, provider: SitePilotOAuthProvider) {
    const form = request.method === "POST" ? await readForm(request) : null;
    const requestId = (form ? form.get("request") : url.searchParams.get("request")) ?? "";
    const pending = /^[A-Za-z0-9_-]+$/.test(requestId) ? await provider.pending(requestId) : null;
    if (!pending) {
      return sendHtml(
        response,
        400,
        messagePage("Connection expired", "This connection request has expired or was already answered. Start connecting again from your app.")
      );
    }
    const user = await currentUser(request);
    if (!user) {
      return redirect(response, `/auth/wordpress/start?return=${encodeURIComponent(`/oauth/consent?request=${requestId}`)}`);
    }
    if (request.method === "GET") {
      if (await provider.hasConsent(user, pending)) return redirect(response, await provider.approve(user, pending));
      const redirectTo = new URL(pending.params.redirectUri);
      return sendHtml(
        response,
        200,
        consentPage({
          user,
          requestId,
          clientName: clientDisplayName(pending.client),
          redirectHost: redirectTo.host,
          scopes: provider.grantableScopes(user, pending)
        }),
        [],
        [redirectTo.origin]
      );
    }
    const allow = form?.get("decision") === "allow";
    redirect(response, allow ? await provider.approve(user, pending) : await provider.deny(pending));
  }

  async function account(request: IncomingMessage, response: ServerResponse, user: SignedInUser) {
    let newToken: string | undefined;
    if (request.method === "POST") {
      const form = await readForm(request);
      newToken = await deps.auth.createApiToken(user, (form.get("label") ?? "").trim());
    }
    sendHtml(
      response,
      200,
      accountPage({
        user,
        tokens: await deps.auth.listApiTokens(user),
        apps: deps.oauth ? await deps.oauth.provider.connectedApps(user) : [],
        slackAccounts: deps.slack?.enabled ? await deps.slack.linkedSlackAccounts(user) : null,
        mcpUrl: new URL("/mcp", deps.publicUrl).toString(),
        ...(newToken ? { newToken } : {})
      })
    );
  }

  /** The admin area: everyone's role, apps, tokens and Slack. */
  async function people(response: ServerResponse, admin: SignedInUser) {
    const listed = await deps.auth.listPeople(admin.siteId);
    const withAccess = await Promise.all(
      listed.map(async (person) => {
        const ref: PersonRef = { siteId: admin.siteId, wordpressUserId: person.wordpressUserId };
        return {
          ...person,
          tokens: await deps.auth.listApiTokens(ref),
          apps: deps.oauth ? await deps.oauth.provider.connectedApps(ref) : [],
          slackAccounts: deps.slack ? await deps.slack.linkedSlackAccounts(ref) : 0,
          sessions: await deps.auth.activeSessionCount(ref)
        };
      })
    );
    sendHtml(response, 200, peoplePage({ user: admin, people: withAccess }));
  }

  /** Records an admin's change to someone's access in the site's audit log. */
  async function recordAccessChange(admin: SignedInUser, person: Person, change: string, detail: Record<string, string | number>) {
    const now = new Date().toISOString();
    await getDatabase().repositories.auditEntries.append({
      id: randomUUID() as never,
      siteId: admin.siteId as SiteId,
      eventType: "access_changed",
      actor: { userProfileId: admin.userProfileId as never, appRole: admin.appRole, siteRoles: admin.siteRoles, source: "hosted_app" },
      metadata: { change, person: person.login, wordpressUserId: person.wordpressUserId, ...detail },
      createdAt: now,
      updatedAt: now
    });
    console.log(`Access changed by ${admin.login}: ${change} for ${person.login}.`);
  }

  /** One change to someone's access, from the admin area. */
  async function changeAccess(
    request: IncomingMessage,
    response: ServerResponse,
    admin: SignedInUser,
    wordpressUserId: number,
    change: "role" | "app" | "token" | "slack" | "sign-out",
    target = ""
  ) {
    const person = (await deps.auth.listPeople(admin.siteId)).find((each) => each.wordpressUserId === wordpressUserId);
    if (!person) return sendHtml(response, 404, messagePage("Not found", "That person hasn't signed in to SitePilot.", admin));
    const ref: PersonRef = { siteId: admin.siteId, wordpressUserId };
    let detail: Record<string, string | number> | null = null;
    if (change === "role") {
      const value = (await readForm(request)).get("role") ?? "";
      const override = value === "wordpress" ? null : isRoleOverride(value) ? value : undefined;
      if (override === undefined) return refuse(response, admin, "Choose one of the roles.", 400);
      if (person.wordpressRole === "admin") {
        return refuse(response, admin, "WordPress administrators are always admins here. Change their role in WordPress.");
      }
      if (await deps.auth.setRoleOverride(ref, override, admin.displayName)) detail = { role: override ?? "wordpress" };
    } else if (change === "app" && deps.oauth) {
      const app = (await deps.oauth.provider.connectedApps(ref)).find((each) => each.grantId === target);
      if (app && (await deps.oauth.provider.disconnect(ref, target))) detail = { app: app.clientName };
    } else if (change === "token") {
      const token = (await deps.auth.listApiTokens(ref)).find((each) => each.tokenHash === target);
      if (token && (await deps.auth.revokeApiToken(ref, target))) detail = { token: token.label };
    } else if (change === "slack" && deps.slack) {
      const unlinked = await deps.slack.disconnect(ref);
      if (unlinked > 0) detail = { slackAccounts: unlinked };
    } else if (change === "sign-out") {
      const ended = await deps.auth.endSessionsFor(ref);
      if (ended > 0) detail = { sessions: ended };
    }
    if (detail) await recordAccessChange(admin, person, change, detail);
    redirect(response, `/admin/people#person-${wordpressUserId}`);
  }

  /** A signed preview link: no sign-in, until it expires. */
  async function reviewLinkImage(response: ServerResponse, links: ReviewLinks, token: string) {
    const target = links.verify(token);
    if (!target) return send(response, 404, "This preview link has expired or isn't valid.", { "content-type": "text/plain; charset=utf-8" });
    const result = await deps.backend.getReviewArtifact(target, {
      clientName: HOSTED_APP_CLIENT_NAME,
      actor: { userProfileId: "review-link", appRole: "read_only_auditor", siteRoles: ["audit_only"] }
    });
    if (result.ok && result.artifact.mimeType === "application/json") {
      // The structure artifact: what changes in the block markup, as text.
      return send(response, 200, structureDiffText(Buffer.from(result.artifact.dataBase64, "base64").toString("utf8")), {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
    }
    if (!result.ok || !result.artifact.mimeType.startsWith("image/")) {
      return send(response, 404, "That preview isn't available any more.", { "content-type": "text/plain; charset=utf-8" });
    }
    send(response, 200, Buffer.from(result.artifact.dataBase64, "base64"), {
      "content-type": result.artifact.mimeType,
      "cache-control": "no-store"
    });
  }

  /** True when the route was handled. */
  return async function route(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", deps.publicUrl);
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (path === "/mcp") {
      await deps.mcp(request, response);
      return true;
    }
    // Called by apps and their servers, not these pages: PKCE and client
    // checks protect them, not cookies.
    if (deps.oauth && isOAuthPath(path)) {
      await deps.oauth.endpoints(request, response);
      return true;
    }
    // Slack's servers: they sign each request instead.
    if (deps.slack && path === "/slack/events" && method === "POST") {
      await deps.slack.handleEvents(request, response);
      return true;
    }
    if (deps.slack && path === "/slack/interactions" && method === "POST") {
      await deps.slack.handleInteractions(request, response);
      return true;
    }
    // Every form post must come from these pages.
    if (method === "POST" && !isSameOrigin(request, deps.publicUrl)) {
      send(response, 403, "Cross-site form posts aren't allowed.", { "content-type": "text/plain" });
      return true;
    }
    if (path === "/" && method === "GET") return home(request, response).then(() => true);
    if (path === "/auth/wordpress/start" && method === "GET") return startSignIn(response, url).then(() => true);
    if (deps.slack && path === "/slack/connect" && (method === "GET" || method === "POST")) {
      const user = await currentUser(request);
      if (!user) {
        const back = `/slack/connect?token=${url.searchParams.get("token") ?? ""}`;
        redirect(response, RETURN_PATH.test(back) ? `/auth/wordpress/start?return=${encodeURIComponent(back)}` : "/");
        return true;
      }
      await deps.slack.connectPage(request, response, user, url.searchParams.get("token") ?? "", (title, body) => layout(title, body, user));
      return true;
    }
    if (deps.oauth && path === "/oauth/consent" && (method === "GET" || method === "POST")) {
      return consent(request, response, url, deps.oauth.provider).then(() => true);
    }
    if (path === "/auth/wordpress/callback" && method === "GET") {
      return finishSignIn(request, response, url).then(() => true);
    }
    if (path === "/auth/sign-out" && method === "POST") {
      await deps.auth.endSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      redirect(response, "/", [sessionCookie("", 0)]);
      return true;
    }
    if (path === "/sites/connect" && (method === "GET" || method === "POST")) {
      return connectSite(request, response, await currentUser(request)).then(() => true);
    }
    const reviewLink = /^\/r\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(path);
    if (deps.reviewLinks && reviewLink && method === "GET") {
      return reviewLinkImage(response, deps.reviewLinks, reviewLink[1] as string).then(() => true);
    }
    if (deps.app && BRAND_FILES.has(path) && method === "GET") {
      if (!deps.app.serveFile(response, path)) send(response, 404, "Not found", { "content-type": "text/plain" });
      return true;
    }
    if (deps.app && path.startsWith("/assets/") && method === "GET") {
      if (!deps.app.serveFile(response, path)) send(response, 404, "Not found", { "content-type": "text/plain" });
      return true;
    }
    const ipc = /^\/api\/ipc\/([A-Za-z0-9.]+)$/.exec(path);
    if (deps.app && ipc && method === "POST") {
      const user = await currentUser(request);
      if (!user) {
        send(response, 401, JSON.stringify({ ok: false, code: "signed_out", message: "Sign in again with WordPress." }), {
          "content-type": "application/json"
        });
        return true;
      }
      const app = deps.app;
      await asHostedUser(user, () => app.handleIpc(request, response, ipc[1] as string, user));
      return true;
    }

    if (path === "/admin" && method === "GET") {
      redirect(response, "/admin/people");
      return true;
    }
    const signedIn = path === "/account" || path.startsWith("/account/") || path === "/admin/people" || path.startsWith("/admin/");
    if (!signedIn) return false;
    const user = await requireUser(request, response);
    if (!user) return true;

    if (path === "/account" && (method === "GET" || method === "POST")) {
      return account(request, response, user).then(() => true);
    }
    if (path === "/account/tokens" && method === "POST") return account(request, response, user).then(() => true);
    if (path === "/account/slack/disconnect" && method === "POST" && deps.slack) {
      await deps.slack.disconnect(user);
      redirect(response, "/account");
      return true;
    }
    const disconnect = /^\/account\/apps\/([0-9a-f-]{36})\/disconnect$/.exec(path);
    if (disconnect && method === "POST" && deps.oauth) {
      await deps.oauth.provider.disconnect(user, disconnect[1] as string);
      redirect(response, "/account");
      return true;
    }
    const revoke = /^\/account\/tokens\/([a-f0-9]{64})\/revoke$/.exec(path);
    if (revoke && method === "POST") {
      await deps.auth.revokeApiToken(user, revoke[1] as string);
      redirect(response, "/account");
      return true;
    }
    if (path === "/admin/people" || path.startsWith("/admin/")) {
      // WordPress administrators only: they prove it with the same sign-in.
      if (user.appRole !== "admin") {
        refuse(response, user, "Only the site's WordPress administrators can manage people here.");
        return true;
      }
      if (path === "/admin/people" && method === "GET") return people(response, user).then(() => true);
      const admin =
        /^\/admin\/people\/(\d+)\/(?:(role|slack\/unlink|sign-out)|apps\/([0-9a-f-]{36})\/disconnect|tokens\/([a-f0-9]{64})\/revoke)$/.exec(path);
      if (admin && method === "POST") {
        const [, id, simple, grantId, tokenHash] = admin as unknown as [string, string, string | undefined, string | undefined, string | undefined];
        const change = simple === "role" ? "role" : simple === "slack/unlink" ? "slack" : simple === "sign-out" ? "sign-out" : grantId ? "app" : "token";
        return changeAccess(request, response, user, Number(id), change, grantId ?? tokenHash ?? "").then(() => true);
      }
    }
    sendHtml(response, 404, layout("Not found", "<h1>Not found</h1>", user));
    return true;
  };
}
