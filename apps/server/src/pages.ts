import type {
  McpRequestStatus,
  McpThreadSummary
} from "@sitepilot/mcp-server";

import type { ApiTokenSummary, SignedInUser } from "./auth.js";
import { escapeHtml as e } from "./http.js";

/** Server-rendered pages: no scripts, every value escaped. */

const STYLE = `
:root{color-scheme:light dark;--fg:#1d2327;--muted:#646970;--line:#dcdcde;--accent:#2271b1;--bg:#fff;--card:#f6f7f7}
@media (prefers-color-scheme:dark){:root{--fg:#f0f0f1;--muted:#a7aaad;--line:#3c434a;--accent:#72aee6;--bg:#1d2327;--card:#2c3338}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:.75rem 1rem;border-bottom:1px solid var(--line)}
header strong{margin-right:auto}main{max-width:52rem;margin:0 auto;padding:1rem}
a{color:var(--accent)}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem;margin:1rem 0}
input,textarea,select{font:inherit;width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
textarea{min-height:7rem}label{display:block;margin:.75rem 0 .25rem;font-weight:600}
button,.button{font:inherit;display:inline-block;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;text-decoration:none;cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}form.inline{display:inline}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top}
img.preview{max-width:100%;border:1px solid var(--line);border-radius:6px}code,pre{font:14px ui-monospace,Menlo,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
.state{display:inline-block;padding:.1rem .5rem;border-radius:999px;border:1px solid var(--line);font-size:.875rem}.error{color:#d63638}`;

export function layout(title: string, body: string, user?: SignedInUser | null): string {
  const nav = user
    ? `<a href="/requests">Requests</a><a href="/account">${e(user.displayName)}</a>
       <form class="inline" method="post" action="/auth/sign-out"><button class="secondary" type="submit">Sign out</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · SitePilot</title><style>${STYLE}</style></head>
<body><header><strong>SitePilot</strong>${nav}</header><main>${body}</main></body></html>`;
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
  newToken?: string;
  mcpUrl: string;
}): string {
  const { user } = input;
  const canApprove = user.siteRoles.includes("approve");
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
       Role: <strong>${e(user.appRole)}</strong>. ${canApprove ? "You can approve changes." : "You can make requests; someone who can publish approves them."}</p>
     <h2>Claude and Codex</h2>
     <p>Use SitePilot from Claude Code or Codex with a personal token. Tokens act as you; revoke one you no longer use.</p>
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

const STATE_LABELS: Record<string, string> = {
  preparing_preview: "Preparing the preview",
  needs_your_reply: "Needs your reply",
  awaiting_approval: "Waiting for approval",
  approved: "Approved",
  applying: "Applying",
  completed: "Done",
  rejected: "Rejected",
  needs_attention: "Needs attention"
};

export function requestsPage(input: {
  user: SignedInUser;
  threads: McpThreadSummary[];
  canRequest: boolean;
}): string {
  const rows = input.threads
    .map(
      (thread) => `<tr><td><a href="/requests/${e(thread.threadId)}">${e(thread.title)}</a></td>
        <td><span class="state">${e(STATE_LABELS[thread.state ?? ""] ?? thread.state ?? "")}</span></td>
        <td class="muted">${e(thread.source ?? "")}</td><td class="muted">${e(thread.updatedAt.slice(0, 16).replace("T", " "))}</td></tr>`
    )
    .join("");
  return layout(
    "Requests",
    `<h1>Requests</h1>
     ${
       input.canRequest
         ? `<form method="post" action="/requests" class="card">
             <label for="text">What should change?</label>
             <textarea id="text" name="text" required placeholder="Write a short post announcing our new opening hours."></textarea>
             <label for="postId">Existing post ID (leave empty for a new draft)</label>
             <input id="postId" name="postId" inputmode="numeric" pattern="[0-9]*">
             <p><button type="submit">Make a request</button></p>
           </form>`
         : ""
     }
     ${rows ? `<table><thead><tr><th>Request</th><th>State</th><th>From</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No requests yet.</p>`}`,
    input.user
  );
}

export function requestPage(input: {
  user: SignedInUser;
  status: McpRequestStatus;
  canApprove: boolean;
  canReply: boolean;
  notice?: string;
}): string {
  const { status } = input;
  const changes = status.changes;
  const previews = (status.reviewArtifacts ?? []).filter((artifact) => artifact.kind === "preview");
  const messages = status.recentMessages
    .map((message) => `<p><strong>${message.from === "you" ? "Request" : "SitePilot"}:</strong> ${e(message.text)}</p>`)
    .join("");
  return layout(
    status.title,
    `<p><a href="/requests">← Requests</a></p>
     <h1>${e(status.title)}</h1>
     <p><span class="state">${e(STATE_LABELS[status.state] ?? status.state)}</span> ${e(status.summary)}</p>
     ${input.notice ? `<p class="card">${e(input.notice)}</p>` : ""}
     ${status.question ? `<div class="card"><strong>SitePilot asks:</strong> ${e(status.question)}</div>` : ""}
     ${status.failure ? `<p class="error">${e(status.failure.message)}</p>` : ""}
     ${
       changes
         ? `<div class="card"><h2>The change</h2><p>${e(changes.operation)}${changes.title ? `: <strong>${e(changes.title)}</strong>` : ""}</p>
            ${changes.excerpt ? `<p class="muted">${e(changes.excerpt)}</p>` : ""}
            ${(changes.seo ?? []).map((item) => `<p>${e(item.label)}: ${e(item.value)}</p>`).join("")}
            ${changes.featuredImage ? `<p>Featured image: ${e(changes.featuredImage)}</p>` : ""}</div>`
         : ""
     }
     ${previews.map((preview) => `<p><img class="preview" alt="Preview" src="/requests/${e(status.requestId)}/artifacts/${e(preview.id)}"></p>`).join("")}
     ${status.result?.editUrl ? `<p><a href="${e(status.result.editUrl)}">Open the post in WordPress</a></p>` : ""}
     ${
       input.canApprove && status.state === "awaiting_approval"
         ? `<form method="post" action="/requests/${e(status.requestId)}/decision" class="card">
             <p>Approving applies the change to the site straight away.</p>
             <button type="submit" name="decision" value="approved">Approve and apply</button>
             <button class="secondary" type="submit" name="decision" value="rejected">Reject</button>
           </form>`
         : ""
     }
     ${
       input.canReply && !["completed", "rejected", "applying"].includes(status.state)
         ? `<form method="post" action="/requests/${e(status.requestId)}/reply">
             <label for="reply">${status.question ? "Your answer" : "Ask for a change"}</label>
             <textarea id="reply" name="text" required></textarea>
             <p><button class="secondary" type="submit">Send</button></p>
           </form>`
         : ""
     }
     ${messages ? `<h2>History</h2>${messages}` : ""}`,
    input.user
  );
}
