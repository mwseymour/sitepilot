import { inlineAppBundle } from "./review-card.js";

/**
 * The card that lets someone add images or videos to a request from a chat
 * app that shows MCP Apps (claude.ai). The model can't hand SitePilot a file
 * the person pasted, so the person chooses it here. The card sends the files
 * with attach_from_card, a tool only the card can call, with a one-use ticket
 * for this request and this person.
 */

export const UPLOAD_CARD_URI = "ui://sitepilot/upload-card.html";

/** Images and MP4 or WebM videos, up to 10 MB each and 6 at a time, as the app allows. */
export const UPLOAD_LIMITS = { maxFiles: 6, maxBytes: 10_000_000 } as const;

const CARD_SCRIPT = `
const { App } = SitePilotApps;
const app = new App({ name: "SitePilot upload", version: "1.0.0" });
const root = document.getElementById("card");
const MAX_FILES = ${UPLOAD_LIMITS.maxFiles};
const MAX_BYTES = ${UPLOAD_LIMITS.maxBytes};

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

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read " + file.name));
    reader.readAsDataURL(file);
  });
}

function render(result) {
  const data = result.structuredContent || {};
  const ticket = result._meta && result._meta["sitepilot/upload"] && result._meta["sitepilot/upload"].ticket;
  root.replaceChildren();
  if (!data.requestId || !ticket) {
    root.append(el("p", { class: "muted" }, "This upload card has expired. Ask for a new one."));
    return;
  }
  let files = [];
  const list = el("div", { class: "files" });
  const status = el("p", { class: "status", role: "status" });
  const note = el("textarea", { rows: "2", placeholder: "What to do with them, for example: below the table" });
  note.value = data.note || "";
  const input = el("input", { type: "file", multiple: "", accept: "image/*,video/mp4,video/webm", class: "hidden" });
  const send = el("button", { class: "primary", disabled: "" }, "Add to request");
  const show = () => {
    list.replaceChildren(...files.map((file, index) => {
      const remove = el("button", { class: "link", onclick: () => { files.splice(index, 1); show(); } }, "Remove");
      let thumb = el("span", { class: "video" }, file.type.startsWith("image/") ? "Image" : "Video");
      if (file.type.startsWith("image/")) {
        // The host may not allow local previews: then the name is enough.
        const image = el("img", { src: URL.createObjectURL(file), alt: "" });
        image.addEventListener("error", () => image.replaceWith(el("span", { class: "video" }, "Image")));
        thumb = image;
      }
      return el("figure", {}, thumb, el("figcaption", {}, file.name, " · ", remove));
    }));
    send.disabled = files.length === 0;
  };
  const add = (chosen) => {
    for (const file of chosen) {
      if (!/^(image\\/|video\\/(mp4|webm)$)/.test(file.type)) { status.textContent = file.name + " isn't an image or an MP4 or WebM video."; continue; }
      if (file.size > MAX_BYTES) { status.textContent = file.name + " is over 10 MB."; continue; }
      if (files.length >= MAX_FILES) { status.textContent = "Up to " + MAX_FILES + " files at a time."; break; }
      files.push(file);
    }
    show();
  };
  input.addEventListener("change", () => { add(Array.from(input.files || [])); input.value = ""; });
  const zone = el("div", { class: "zone", tabindex: "0", onclick: () => input.click(), onkeydown: (event) => { if (event.key === "Enter" || event.key === " ") input.click(); } },
    el("strong", {}, "Drop images here, or choose them"),
    el("span", { class: "muted small" }, "Images, or MP4 and WebM videos, up to 10 MB each")
  );
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => { event.preventDefault(); zone.classList.remove("over"); add(Array.from(event.dataTransfer.files || [])); });
  send.addEventListener("click", async () => {
    send.disabled = true;
    send.textContent = "Adding…";
    status.textContent = "";
    try {
      const payload = await Promise.all(files.map(async (file) => ({ file_name: file.name, media_type: file.type, data_url: await readAsDataUrl(file) })));
      const answer = await app.callServerTool({
        name: "attach_from_card",
        arguments: { site_id: data.siteId, request_id: data.requestId, ticket, files: payload, ...(note.value.trim() ? { note: note.value.trim() } : {}) }
      });
      const text = (answer.content || []).map((part) => part.text || "").join(" ");
      if (answer.isError) {
        status.textContent = "Not added: " + text;
        send.textContent = "Try again";
        send.disabled = false;
        return;
      }
      status.textContent = text;
      send.textContent = "Added";
      zone.remove();
      note.disabled = true;
      for (const button of list.querySelectorAll("button")) button.remove();
    } catch (error) {
      status.textContent = "Not added: " + (error && error.message ? error.message : String(error));
      send.textContent = "Try again";
      send.disabled = false;
    }
  });
  root.append(
    el("div", { class: "head" }, el("strong", {}, "Add images to: " + (data.title || "the request"))),
    zone, input, list,
    el("label", {}, "Note for SitePilot (optional)", note),
    el("div", { class: "actions" }, send),
    status
  );
}

app.ontoolresult = render;
await app.connect();
`;

const CARD_STYLE = `
:root { color-scheme: light dark; --fg: #1d2327; --muted: #646970; --line: #dcdcde; --accent: #2271b1; --bg: transparent; }
@media (prefers-color-scheme: dark) { :root { --fg: #f0f0f1; --muted: #a7aaad; --line: #3c434a; --accent: #72aee6; } }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
#card { padding: 12px 14px; display: grid; gap: 10px; }
.muted { color: var(--muted); } .small { font-size: 12px; }
.zone { border: 1.5px dashed var(--line); border-radius: 8px; padding: 18px; display: grid; gap: 4px; justify-items: center; cursor: pointer; text-align: center; }
.zone.over, .zone:focus { border-color: var(--accent); outline: none; }
.hidden { display: none; }
.files { display: flex; flex-wrap: wrap; gap: 8px; }
figure { margin: 0; width: 120px; }
figure img, .video { width: 120px; height: 80px; object-fit: cover; border: 1px solid var(--line); border-radius: 6px; display: grid; place-items: center; }
figcaption { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
textarea { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px; resize: vertical; }
.actions { display: flex; gap: 8px; }
button { font: inherit; cursor: pointer; border-radius: 6px; padding: 6px 12px; border: 1px solid var(--accent); background: transparent; color: var(--accent); }
button.primary { background: var(--accent); color: #fff; } button:disabled { opacity: .6; cursor: default; }
button.link { border: 0; padding: 0; text-decoration: underline; font-size: 12px; }
.status { font-size: 13px; margin: 0; }
`;

export function uploadCardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CARD_STYLE}</style></head>
<body><div id="card"><p class="muted">Loading…</p></div>
<script type="module">${inlineAppBundle()}
// In its own block: the minified bundle above shares this module's scope.
{${CARD_SCRIPT}}</script></body></html>`;
}
