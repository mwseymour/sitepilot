import type { ApiTokenSummary, Person, RoleOverride, SignedInUser } from "./auth.js";
import { escapeHtml as e } from "./http.js";
import { SCOPE_DESCRIPTIONS, type ConnectedApp, type OAuthScope } from "./oauth.js";

/** Server-rendered pages: no scripts, every value escaped. */

const STYLE = `
:root{color-scheme:light dark;--fg:#1d2327;--muted:#646970;--line:#dcdcde;--accent:#2271b1;--bg:#fff;--card:#f6f7f7}
@media (prefers-color-scheme:dark){:root{--fg:#f0f0f1;--muted:#a7aaad;--line:#3c434a;--accent:#72aee6;--bg:#1d2327;--card:#2c3338}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:.75rem 1rem;border-bottom:1px solid var(--line)}
header strong{margin-right:auto;display:flex;align-items:center;gap:.5rem}main{max-width:52rem;margin:0 auto;padding:1rem}
a{color:var(--accent)}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem;margin:1rem 0}
input,textarea,select{font:inherit;width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
textarea{min-height:7rem}label{display:block;margin:.75rem 0 .25rem;font-weight:600}
button,.button{font:inherit;display:inline-block;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;text-decoration:none;cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}form.inline{display:inline}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top}
code,pre{font:14px ui-monospace,Menlo,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
.error{color:#d63638}`;

/** The SitePilot mark. The source is assets/brand/sitepilot-mark.svg. */
const MARK = `<svg viewBox="0 0 64 64" width="24" height="24" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0e6a61"/><path d="M36 21h-8a7 7 0 0 0 0 14h6a7 7 0 0 1 0 14H19" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36.5 13.5 46.5 21l-10 7.5Z" fill="#f2862e" stroke="#f2862e" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

const ICONS = `<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/sitepilot-mark.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

export function layout(title: string, body: string, user?: SignedInUser | null): string {
  const nav = user
    ? `<a href="/">Open SitePilot</a>${user.appRole === "admin" ? `<a href="/admin/people">People</a>` : ""}<a href="/account">${e(user.displayName)}</a>
       <form class="inline" method="post" action="/auth/sign-out"><button class="secondary" type="submit">Sign out</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · SitePilot</title>${ICONS}<style>${STYLE}</style></head>
<body><header><strong>${MARK}SitePilot</strong>${nav}</header><main>${body}</main></body></html>`;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Admin",
  admin: "Admin",
  approver: "Approver",
  requester: "Requester",
  read_only_auditor: "Read only"
};

const OVERRIDE_LABELS: Record<RoleOverride, string> = {
  approver: "Approver: makes and approves requests",
  requester: "Requester: makes requests; someone else approves them",
  read_only: "Read only: sees requests and history",
  none: "No access: SitePilot is off for them"
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function when(iso: string | null | undefined, fallback = "Never"): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : fallback;
}

export function messagePage(title: string, message: string, user?: SignedInUser | null): string {
  return layout(title, `<h1>${e(title)}</h1><p>${e(message)}</p><p><a href="/">Back</a></p>`, user);
}

export function homePage(input: { siteName: string | null }): string {
  if (!input.siteName) {
    return layout(
      "Welcome",
      `<h1>Connect your WordPress site</h1>
       <p>SitePilot isn't connected to a site yet. You'll need the registration code from the site's Settings → SitePilot page.</p>
       <p><a class="button" href="/sites/connect">Connect a site</a></p>`
    );
  }
  return layout(
    "Sign in",
    `<h1>Sign in</h1>
     <p>SitePilot manages <strong>${e(input.siteName)}</strong>. Sign in with your WordPress account on that site; what you can do here follows what you can do there.</p>
     <p><a class="button" href="/auth/wordpress/start">Sign in with WordPress</a></p>`
  );
}

export function connectPage(input: { error?: string; values?: Record<string, string> }): string {
  const value = (name: string) => e(input.values?.[name] ?? "");
  return layout(
    "Connect a site",
    `<h1>Connect a WordPress site</h1>
     ${input.error ? `<p class="error">${e(input.error)}</p>` : ""}
     <form method="post" action="/sites/connect">
       <label for="siteUrl">Site address</label>
       <input id="siteUrl" name="siteUrl" type="url" required placeholder="https://example.com" value="${value("siteUrl")}">
       <label for="registrationCode">Registration code</label>
       <input id="registrationCode" name="registrationCode" required autocomplete="off">
       <label for="wordpressUsername">WordPress username SitePilot acts as</label>
       <input id="wordpressUsername" name="wordpressUsername" required value="${value("wordpressUsername")}">
       <p class="muted">SitePilot makes approved changes as this user, with exactly its permissions.</p>
       <p><button type="submit">Connect</button></p>
     </form>`
  );
}

export function accountPage(input: {
  user: SignedInUser;
  tokens: ApiTokenSummary[];
  apps: ConnectedApp[];
  /** Linked Slack accounts, or null when the Slack app isn't set up. */
  slackAccounts?: number | null;
  newToken?: string;
  mcpUrl: string;
}): string {
  const { user } = input;
  const canApprove = user.siteRoles.includes("approve");
  const canRequest = user.siteRoles.includes("request");
  const tokenRows = input.tokens
    .map(
      (token) => `<tr><td>${e(token.label)}</td><td>${e(token.createdAt.slice(0, 10))}</td>
        <td>${e(token.lastUsedAt?.slice(0, 16).replace("T", " ") ?? "Never")}</td>
        <td><form class="inline" method="post" action="/account/tokens/${e(token.tokenHash)}/revoke"><button class="secondary" type="submit">Revoke</button></form></td></tr>`
    )
    .join("");
  return layout(
    "Account",
    `<h1>${e(user.displayName)}</h1>
     <p>Signed in with WordPress as <strong>${e(user.login)}</strong>${user.email ? ` (${e(user.email)})` : ""}.
       Role: <strong>${e(roleLabel(user.appRole))}</strong>${user.roleSetByAdmin ? " (set by a site admin)" : ""}.
       ${canApprove ? "You can approve changes." : canRequest ? "You can make requests; someone who can publish approves them." : "You can see requests, but not make them."}</p>
     ${user.appRole === "admin" ? `<p><a href="/admin/people">People and access</a>: everyone's roles, apps, tokens and Slack.</p>` : ""}
     <h2>Connected apps</h2>
     <p>To use SitePilot from claude.ai or Claude Desktop, add a custom connector with this address, then sign in when it asks:</p>
     <pre>${e(input.mcpUrl)}</pre>
     ${
       input.apps.length > 0
         ? `<table><thead><tr><th>App</th><th>Allowed</th><th>Connected</th><th>Last used</th><th></th></tr></thead><tbody>${input.apps
             .map(
               (app) => `<tr><td>${e(app.clientName)}</td><td>${e(app.scopes.join(", "))}</td><td>${e(app.connectedAt.slice(0, 10))}</td>
                 <td>${e(app.lastUsedAt?.slice(0, 16).replace("T", " ") ?? "Not yet")}</td>
                 <td><form class="inline" method="post" action="/account/apps/${e(app.grantId)}/disconnect"><button class="secondary" type="submit">Disconnect</button></form></td></tr>`
             )
             .join("")}</tbody></table>`
         : `<p class="muted">No apps connected yet.</p>`
     }
     ${
       input.slackAccounts === null || input.slackAccounts === undefined
         ? ""
         : `<h2>Slack</h2>${
             input.slackAccounts > 0
               ? `<p>Your Slack account is connected: mention @SitePilot in Slack to make a request.</p>
                  <form method="post" action="/account/slack/disconnect"><button class="secondary" type="submit">Disconnect Slack</button></form>`
               : `<p class="muted">Not connected. Mention @SitePilot in Slack, and it will give you a link to connect.</p>`
           }`
     }
     <h2>Personal tokens</h2>
     <p>For Claude Code or Codex without signing in, use a personal token. Tokens act as you; revoke one you no longer use.</p>
     ${
       input.newToken
         ? `<div class="card"><p><strong>Copy this token now.</strong> It won't be shown again.</p><pre>${e(input.newToken)}</pre>
            <p>Claude Code:</p><pre>claude mcp add --transport http sitepilot ${e(input.mcpUrl)} --header "Authorization: Bearer ${e(input.newToken)}"</pre></div>`
         : ""
     }
     <form method="post" action="/account/tokens">
       <label for="label">New token for</label><input id="label" name="label" placeholder="Claude Code on my laptop">
       <p><button type="submit">Create token</button></p>
     </form>
     ${tokenRows ? `<table><thead><tr><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table>` : ""}`,
    user
  );
}

/** Asks whether an app may use SitePilot as this person. */
export function consentPage(input: {
  user: SignedInUser;
  requestId: string;
  clientName: string;
  redirectHost: string;
  scopes: OAuthScope[];
}): string {
  return layout(
    "Connect an app",
    `<h1>Connect ${e(input.clientName)} to SitePilot?</h1>
     <p>${e(input.clientName)} (returning to <strong>${e(input.redirectHost)}</strong>) is asking to use SitePilot as
       <strong>${e(input.user.displayName)}</strong> (${e(input.user.login)}), with your role in SitePilot. It will be able to:</p>
     <ul>${input.scopes.map((scope) => `<li>${e(SCOPE_DESCRIPTIONS[scope])}</li>`).join("")}</ul>
     <p class="muted">${
       input.scopes.includes("approve")
         ? "It can approve only when you confirm in its own prompt or on the review card: typing in the chat never approves."
         : "It can't approve, apply or publish anything: changes still need a person to approve them in SitePilot."
     }
       You can disconnect it on your account page.</p>
     <form method="post" action="/oauth/consent" class="card">
       <input type="hidden" name="request" value="${e(input.requestId)}">
       <button type="submit" name="decision" value="allow">Allow</button>
       <button class="secondary" type="submit" name="decision" value="deny">Don't allow</button>
     </form>`,
    input.user
  );
}

/** Someone in the admin area, with what they've connected. */
export type PersonAccess = Person & {
  tokens: ApiTokenSummary[];
  apps: ConnectedApp[];
  slackAccounts: number;
  sessions: number;
};

/** The admin area: everyone's role, apps, tokens and Slack, for WordPress administrators. */
export function peoplePage(input: { user: SignedInUser; people: PersonAccess[] }): string {
  const post = (action: string, label: string) =>
    `<form class="inline" method="post" action="${e(action)}"><button class="secondary" type="submit">${e(label)}</button></form>`;
  const cards = input.people.map((person) => {
    const base = `/admin/people/${person.wordpressUserId}`;
    const admin = person.wordpressRole === "admin";
    const options = [
      `<option value="wordpress"${person.roleOverride ? "" : " selected"}>From WordPress (${e(roleLabel(person.wordpressRole))})</option>`,
      ...(Object.keys(OVERRIDE_LABELS) as RoleOverride[]).map(
        (value) => `<option value="${value}"${person.roleOverride === value ? " selected" : ""}>${e(OVERRIDE_LABELS[value])}</option>`
      )
    ].join("");
    const connected = [
      ...person.apps.map(
        (app) => `<li>${e(app.clientName)} <span class="muted">(${e(app.scopes.join(", "))}; last used ${e(when(app.lastUsedAt, "not yet"))})</span>
          ${post(`${base}/apps/${app.grantId}/disconnect`, "Disconnect")}</li>`
      ),
      ...person.tokens.map(
        (token) => `<li>Personal token “${e(token.label)}” <span class="muted">(last used ${e(when(token.lastUsedAt))})</span>
          ${post(`${base}/tokens/${token.tokenHash}/revoke`, "Revoke")}</li>`
      ),
      ...(person.slackAccounts > 0 ? [`<li>Slack ${post(`${base}/slack/unlink`, "Unlink Slack")}</li>`] : []),
      ...(person.sessions > 0
        ? [`<li>Signed in to this app (${person.sessions} browser${person.sessions === 1 ? "" : "s"}) ${post(`${base}/sign-out`, "Sign out everywhere")}</li>`]
        : [])
    ];
    return `<section class="card" id="person-${person.wordpressUserId}">
      <h2>${e(person.displayName)} <span class="muted">${e(person.login)}${person.email ? ` · ${e(person.email)}` : ""}</span></h2>
      <p>WordPress role: <strong>${e(roleLabel(person.wordpressRole))}</strong>. Last signed in ${e(when(person.lastSignInAt))}.</p>
      ${
        admin
          ? `<p class="muted">WordPress administrators are always admins here. To change that, change their role in WordPress.</p>`
          : `<form method="post" action="${base}/role">
              <label for="role-${person.wordpressUserId}">Role in SitePilot</label>
              <select id="role-${person.wordpressUserId}" name="role">${options}</select>
              ${
                person.roleOverride && person.roleOverrideBy
                  ? `<p class="muted">Set by ${e(person.roleOverrideBy)} on ${e(when(person.roleOverrideAt))}.</p>`
                  : ""
              }
              <p><button type="submit">Save role</button></p>
            </form>`
      }
      ${connected.length > 0 ? `<h3>Connected</h3><ul>${connected.join("")}</ul>` : `<p class="muted">Nothing connected.</p>`}
    </section>`;
  });
  return layout(
    "People and access",
    `<h1>People and access</h1>
     <p>Everyone who has signed in to SitePilot with WordPress. Roles come from WordPress: people who can publish approve,
       other editors make requests, and WordPress administrators are admins here. You can give someone a different role,
       or turn SitePilot off for them. A new role applies straight away, everywhere: the app, Slack, Claude and Codex.</p>
     ${cards.length > 0 ? cards.join("") : `<p class="muted">No one has signed in yet.</p>`}`,
    input.user
  );
}
