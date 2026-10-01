import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getDatabase } from "@sitepilot/core/app-database";
import { getSecureStorage } from "@sitepilot/core/app-secure-storage";
import { runWithCallContext } from "@sitepilot/core/call-context";
import { refreshDiscoveryForSite } from "@sitepilot/core/discovery-service";
import {
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  getGutenbergV2RequestState
} from "@sitepilot/core/gutenberg-v2-chat-service";
import { registerSiteWithWordPress } from "@sitepilot/core/register-site";
import { generateAndPersistSiteConfigDraft } from "@sitepilot/core/site-config-draft";
import { confirmSiteConfigActivation } from "@sitepilot/core/site-workspace-service";
import type { ChatThreadId, RequestId, SiteConfigId, SiteId } from "@sitepilot/domain";
import {
  HOSTED_APP_CLIENT_NAME,
  type McpCaller,
  type SitePilotMcpBackend
} from "@sitepilot/mcp-server";

import type { AppShell } from "./app-shell.js";
import {
  AuthStore,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  verifySignInAssertion,
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
import {
  accountPage,
  connectPage,
  homePage,
  layout,
  messagePage,
  requestPage,
  requestsPage
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
};

const WORKSPACE_ID = "workspace-1";

/** The connected site. One site per deployment, as the build spec says. */
async function connectedSite() {
  const sites = await getDatabase().repositories.sites.listByWorkspaceId(
    WORKSPACE_ID as never
  );
  return sites[0] ?? null;
}

function callerFor(user: SignedInUser): McpCaller {
  return {
    clientName: HOSTED_APP_CLIENT_NAME,
    actor: { userProfileId: user.userProfileId, appRole: user.appRole, siteRoles: user.siteRoles }
  };
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

  /** Signed in, or sent to the sign-in page. */
  async function requireUser(request: IncomingMessage, response: ServerResponse) {
    const user = await currentUser(request);
    if (!user) redirect(response, "/");
    return user;
  }

  function refuse(response: ServerResponse, user: SignedInUser | null, message: string, status = 403) {
    sendHtml(response, status, messagePage("Not allowed", message, user));
  }

  async function home(request: IncomingMessage, response: ServerResponse) {
    if (await currentUser(request)) {
      if (deps.app?.available) return void deps.app.serveFile(response, "/");
      return redirect(response, "/requests");
    }
    const site = await connectedSite();
    sendHtml(response, 200, homePage({ siteName: site?.name ?? null }));
  }

  async function startSignIn(response: ServerResponse) {
    const site = await connectedSite();
    if (!site) return redirect(response, "/");
    const state = randomBytes(24).toString("base64url");
    const target = new URL("/wp-admin/admin-post.php", site.baseUrl);
    target.searchParams.set("action", "sitepilot_sign_in");
    target.searchParams.set("site_id", site.id);
    target.searchParams.set("state", state);
    redirect(response, target.toString(), [
      cookie(STATE_COOKIE, `${state}.${site.id}`, { maxAgeSeconds: STATE_TTL_SECONDS, secure })
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
    const token = await deps.auth.createSession(user);
    redirect(response, "/", [clearState, sessionCookie(token, SESSION_TTL_SECONDS)]);
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
        mcpUrl: new URL("/mcp", deps.publicUrl).toString(),
        ...(newToken ? { newToken } : {})
      })
    );
  }

  async function requests(request: IncomingMessage, response: ServerResponse, user: SignedInUser) {
    const caller = callerFor(user);
    const canRequest = user.siteRoles.includes("request");
    if (request.method === "POST") {
      if (!canRequest) return refuse(response, user, "Your WordPress role can't make requests.");
      const form = await readForm(request);
      const postId = Number.parseInt(form.get("postId") ?? "", 10);
      const created = await deps.backend.createRequest(
        {
          siteId: user.siteId,
          text: (form.get("text") ?? "").trim(),
          target: Number.isInteger(postId) && postId > 0
            ? { operation: "edit", postType: "post", postId }
            : { operation: "create_draft", postType: "post" }
        },
        caller
      );
      if (!created.ok) return sendHtml(response, 400, messagePage("Request not made", created.message, user));
      return redirect(response, `/requests/${encodeURIComponent(created.status.requestId)}`);
    }
    const listed = await deps.backend.listThreads({ siteId: user.siteId, kind: "request", limit: 50 }, caller);
    sendHtml(
      response,
      200,
      requestsPage({ user, threads: listed.ok ? listed.threads : [], canRequest })
    );
  }

  async function showRequest(response: ServerResponse, user: SignedInUser, requestId: string, notice?: string) {
    const status = await deps.backend.requestStatus({ siteId: user.siteId, requestId }, callerFor(user));
    if (!status.ok) return sendHtml(response, 404, messagePage("Request not found", status.message, user));
    sendHtml(
      response,
      200,
      requestPage({
        user,
        status: status.status,
        canApprove: user.siteRoles.includes("approve"),
        canReply: user.siteRoles.includes("request"),
        ...(notice ? { notice } : {})
      })
    );
  }

  async function reply(request: IncomingMessage, response: ServerResponse, user: SignedInUser, requestId: string) {
    if (!user.siteRoles.includes("request")) return refuse(response, user, "Your WordPress role can't make requests.");
    const form = await readForm(request);
    const result = await deps.backend.addToRequest(
      { siteId: user.siteId, requestId, text: (form.get("text") ?? "").trim() },
      callerFor(user)
    );
    if (!result.ok) return showRequest(response, user, requestId, result.message);
    redirect(response, `/requests/${encodeURIComponent(requestId)}`);
  }

  /** Approve applies at once (MCP plan, Phase 0 recommendation). */
  async function decide(request: IncomingMessage, response: ServerResponse, user: SignedInUser, threadId: string) {
    if (!user.siteRoles.includes("approve")) {
      return refuse(response, user, "Only people who can publish on the site can approve.");
    }
    const decision = (await readForm(request)).get("decision") === "approved" ? "approved" : "rejected";
    const siteId = user.siteId as SiteId;
    const requests = await getDatabase().repositories.requests.listByThreadId(threadId as ChatThreadId);
    const latest = [...requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!latest) return showRequest(response, user, threadId, "There's nothing to approve yet.");
    const outcome = await asHostedUser(user, async () => {
      const state = await getGutenbergV2RequestState({ siteId, requestId: latest.id as RequestId });
      const candidateId = state.ok ? state.state?.candidate?.candidateId : undefined;
      if (!candidateId) return { ok: false as const, message: "There's no preview to approve yet." };
      const decided = await decideGutenbergV2Candidate({
        siteId,
        requestId: latest.id as RequestId,
        candidateId,
        decision,
        applyingNow: decision === "approved"
      });
      if (!("state" in decided)) return { ok: false as const, message: decided.message };
      if (decision === "approved") {
        // Applying takes a minute or more; the page shows its progress.
        void executeGutenbergV2Candidate({ siteId, requestId: latest.id as RequestId }).catch(
          (error: unknown) => console.log(`Applying ${latest.id} failed: ${String(error)}`)
        );
      }
      return { ok: true as const };
    });
    if (!outcome.ok) return showRequest(response, user, threadId, outcome.message);
    redirect(response, `/requests/${encodeURIComponent(threadId)}`);
  }

  async function artifact(response: ServerResponse, user: SignedInUser, requestId: string, artifactId: string) {
    const result = await deps.backend.getReviewArtifact(
      { siteId: user.siteId, requestId, artifactId },
      callerFor(user)
    );
    if (!result.ok) return send(response, 404, "Not found", { "content-type": "text/plain" });
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
    // Every form post must come from these pages.
    if (method === "POST" && !isSameOrigin(request, deps.publicUrl)) {
      send(response, 403, "Cross-site form posts aren't allowed.", { "content-type": "text/plain" });
      return true;
    }
    if (path === "/" && method === "GET") return home(request, response).then(() => true);
    if (path === "/auth/wordpress/start" && method === "GET") return startSignIn(response).then(() => true);
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

    const signedIn = path === "/account" || path === "/requests" || path.startsWith("/account/") || path.startsWith("/requests/");
    if (!signedIn) return false;
    const user = await requireUser(request, response);
    if (!user) return true;

    if (path === "/account" && (method === "GET" || method === "POST")) {
      return account(request, response, user).then(() => true);
    }
    if (path === "/account/tokens" && method === "POST") return account(request, response, user).then(() => true);
    const revoke = /^\/account\/tokens\/([a-f0-9]{64})\/revoke$/.exec(path);
    if (revoke && method === "POST") {
      await deps.auth.revokeApiToken(user, revoke[1] as string);
      redirect(response, "/account");
      return true;
    }
    if (path === "/requests" && (method === "GET" || method === "POST")) {
      return requests(request, response, user).then(() => true);
    }
    const match = /^\/requests\/([A-Za-z0-9-]+)(?:\/(decision|reply|artifacts\/([A-Za-z0-9_-]+)))?$/.exec(path);
    if (match) {
      const [, requestId, action, artifactId] = match as unknown as [string, string, string | undefined, string | undefined];
      if (!action && method === "GET") return showRequest(response, user, requestId).then(() => true);
      if (action === "decision" && method === "POST") return decide(request, response, user, requestId).then(() => true);
      if (action === "reply" && method === "POST") return reply(request, response, user, requestId).then(() => true);
      if (artifactId && method === "GET") return artifact(response, user, requestId, artifactId).then(() => true);
    }
    sendHtml(response, 404, layout("Not found", "<h1>Not found</h1>", user));
    return true;
  };
}
