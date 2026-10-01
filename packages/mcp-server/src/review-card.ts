import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The review card that chat apps supporting MCP Apps (claude.ai) show inline:
 * the desktop and mobile previews, the change list, and Approve and apply /
 * Reject buttons. The buttons call decide_from_card, a tool only the card can
 * call, with a one-use ticket for the preview it shows.
 */

export const REVIEW_CARD_URI = "ui://sitepilot/review-card.html";

let appBundle: string | undefined;

/**
 * The MCP Apps client (App) as an inline script. The card can't load scripts
 * from elsewhere, so the package's self-contained build is inlined, with its
 * final export list turned into a local object.
 */
function inlineAppBundle(): string {
  if (appBundle !== undefined) return appBundle;
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const match = /export\s*\{([^}]*)\};?\s*(?:\/\/# sourceMappingURL=\S*)?\s*$/.exec(source);
  if (!match) throw new Error("The MCP Apps bundle isn't in the expected format.");
  const entries = (match[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [local, exported] = entry.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}: ${local}`;
    });
  appBundle = `${source.slice(0, match.index)}\nconst SitePilotApps = { ${entries.join(", ")} };\n`.replace(
    /<\/script/gi,
    "<\\/script"
  );
  return appBundle;
}

const CARD_SCRIPT = `
const { App } = SitePilotApps;
const app = new App({ name: "SitePilot review", version: "1.0.0" });
const root = document.getElementById("card");

function el(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function render(result) {
  const data = result.structuredContent || {};
  const ticket = result._meta && result._meta["sitepilot/approval"] && result._meta["sitepilot/approval"].ticket;
  root.replaceChildren();
  if (!data.requestId) {
    root.append(el("p", { class: "muted" }, "No review to show."));
    return;
  }
  root.append(
    el("div", { class: "head" },
      el("strong", {}, data.title || "Request"),
      el("span", { class: "state" }, data.stateLabel || data.state || "")
    ),
    el("p", { class: "muted" }, data.summary || "")
  );
  if (data.changes && data.changes.length) {
    root.append(el("ul", {}, ...data.changes.map((line) => el("li", {}, line))));
  }
  const status = el("p", { class: "status", role: "status" });
  const previews = el("div", { class: "previews" });
  for (const preview of data.previews || []) {
    const image = el("img", { src: preview.url, alt: preview.label + " preview" });
    const open = el("button", { class: "link", onclick: () => app.openLink({ url: preview.url }) }, "Open full size");
    previews.append(el("figure", {}, el("div", { class: "shot" }, image), el("figcaption", {}, preview.label, " · ", open)));
  }
  if (ticket && data.state === "awaiting_approval") {
    const decide = async (decision, button) => {
      for (const b of root.querySelectorAll("button.decide")) b.disabled = true;
      button.textContent = decision === "approve" ? "Approving…" : "Rejecting…";
      try {
        const answer = await app.callServerTool({
          name: "decide_from_card",
          arguments: { site_id: data.siteId, request_id: data.requestId, ticket, decision }
        });
        const text = (answer.content || []).map((part) => part.text || "").join(" ");
        status.textContent = answer.isError ? "Not done: " + text : text;
        button.textContent = answer.isError ? "Try again" : decision === "approve" ? "Approved" : "Rejected";
        if (answer.isError) for (const b of root.querySelectorAll("button.decide")) b.disabled = false;
        else if (decision === "approve") followApply();
      } catch (error) {
        status.textContent = "Not done: " + (error && error.message ? error.message : String(error));
        for (const b of root.querySelectorAll("button.decide")) b.disabled = false;
      }
    };
    // Applying takes a minute or so: keep the card up to date until it's done.
    const followApply = async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
          const result = await app.callServerTool({
            name: "request_status",
            arguments: { site_id: data.siteId, request_id: data.requestId }
          });
          const parts = (result.content || []).map((part) => part.text || "");
          const current = JSON.parse(parts[parts.length - 1] || "{}");
          if (current.state === "completed") {
            status.textContent = "Done. Written to the site and verified.";
            return;
          }
          if (current.state === "needs_attention" || current.state === "rejected") {
            status.textContent = "SitePilot couldn't finish: " + ((current.failure && current.failure.message) || current.summary || current.state);
            return;
          }
        } catch {
          // Keep trying: a status check can fail while the site is busy.
        }
      }
      status.textContent = "Still applying. Ask Claude for the request's status.";
    };
    const approve = el("button", { class: "decide primary", onclick: (event) => decide("approve", event.currentTarget) }, "Approve and apply");
    const reject = el("button", { class: "decide", onclick: (event) => decide("reject", event.currentTarget) }, "Reject");
    root.append(el("div", { class: "actions" }, approve, reject), el("p", { class: "muted small" }, "Approving applies the change to the site straight away. Only your click here approves it."), status);
  } else if (data.state === "awaiting_approval") {
    root.append(el("p", { class: "muted small" }, "To approve from here, reconnect SitePilot and allow it to approve changes. Your WordPress role must be able to publish."));
  }
  root.append(previews);
}

app.ontoolresult = render;
await app.connect();
`;

const CARD_STYLE = `
:root { color-scheme: light dark; --fg: #1d2327; --muted: #646970; --line: #dcdcde; --accent: #2271b1; --bg: transparent; }
@media (prefers-color-scheme: dark) { :root { --fg: #f0f0f1; --muted: #a7aaad; --line: #3c434a; --accent: #72aee6; } }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
#card { padding: 12px 14px; }
.head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
.state { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 12px; white-space: nowrap; }
.muted { color: var(--muted); margin: 6px 0; } .small { font-size: 12px; }
ul { margin: 6px 0 10px; padding-left: 18px; }
.previews { display: grid; grid-template-columns: 3fr 1fr; gap: 10px; align-items: start; margin-top: 12px; }
figure { margin: 0; }
.shot { max-height: 420px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
img { width: 100%; display: block; }
figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
button { font: inherit; cursor: pointer; border-radius: 6px; padding: 6px 12px; border: 1px solid var(--accent); background: transparent; color: var(--accent); }
button.primary { background: var(--accent); color: #fff; } button:disabled { opacity: .6; cursor: default; }
button.link { border: 0; padding: 0; text-decoration: underline; font-size: 12px; }
.status { font-size: 13px; }
`;

export function reviewCardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CARD_STYLE}</style></head>
<body><div id="card"><p class="muted">Loading the review…</p></div>
<script type="module">${inlineAppBundle()}
// In its own block: the minified bundle above shares this module's scope.
{${CARD_SCRIPT}}</script></body></html>`;
}
