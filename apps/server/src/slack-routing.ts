/**
 * Whether a Slack message asks about the site (a Conversation, read-only) or
 * asks for a change (a Request, which still needs an Approve click). Either
 * wrong guess is safe, and when the wording doesn't say, SitePilot asks.
 *
 * Starting with "ask" or "change" (or "request") forces one or the other.
 */

export type SlackRoute =
  | { kind: "conversation"; text: string; forced: boolean }
  | { kind: "request"; text: string; forced: boolean }
  | { kind: "unsure"; text: string };

// Base-form verbs that ask SitePilot to change something. Words that are
// also everyday nouns in questions ("the link", "the embed") are left out.
const CHANGE_VERBS =
  "write|create|draft|add|insert|append|make|update|change|edit|rewrite|rephrase|reword|replace|remove|delete|publish|unpublish|schedule|set|tag|untag|categori[sz]e|move|rename|fix|correct|shorten|lengthen|expand|translate|upload|attach|put|swap|convert|restore|revert|improve|duplicate|build|generate|compose";
const CHANGE_AT_START = new RegExp(`^(?:${CHANGE_VERBS})\\b`, "i");
const CHANGE_ANYWHERE = new RegExp(`\\b(?:${CHANGE_VERBS})\\b`, "i");
// Questions and lookups.
const QUESTION_AT_START =
  /^(?:what|what's|whats|which|who|whose|when|where|why|how|is|are|was|were|do|does|did|has|have|had|list|show|find|search|count|tell me|give me|look up|lookup|get me|fetch)\b/i;
// "Please", "can you" and the like say nothing about which it is.
const POLITE_START =
  /^(?:(?:hey|hi|hello|ok|okay|so|please|pls|kindly)\b[\s,!.]*|(?:can|could|would|will) (?:you|we|u)\b\s*(?:please\b\s*)?|i(?:'d| would) like (?:you )?to\b\s*|i (?:want|need) (?:you )?to\b\s*|let's\b\s*)/i;

function withoutPoliteStart(text: string): string {
  let current = text;
  for (let previous = ""; previous !== current; ) {
    previous = current;
    current = current.replace(POLITE_START, "").trimStart();
  }
  return current;
}

export function routeSlackMessage(raw: string, options: { hasAttachments?: boolean } = {}): SlackRoute {
  const text = raw.trim();
  // "question" only with a colon: "question 5 of the FAQ…" is about a page.
  const ask = /^(?:ask\b|question\s*:)[\s:,-]*/i.exec(text);
  if (ask && text.length > ask[0].length) {
    return { kind: "conversation", text: text.slice(ask[0].length).trim(), forced: true };
  }
  // "change: ..." and "request ..." drop the word; "change the title ..." keeps it.
  const change = /^(?:(?:change|request)\s*:|request\b)[\s,-]*/i.exec(text);
  if (change && text.length > change[0].length) {
    return { kind: "request", text: text.slice(change[0].length).trim(), forced: true };
  }
  if (options.hasAttachments) return { kind: "request", text, forced: false };
  const plain = withoutPoliteStart(text);
  if (CHANGE_AT_START.test(plain)) return { kind: "request", text, forced: false };
  const asks = QUESTION_AT_START.test(plain) || plain.endsWith("?");
  const changes = CHANGE_ANYWHERE.test(plain);
  if (asks && !changes) return { kind: "conversation", text, forced: false };
  if (changes && !asks) return { kind: "request", text, forced: false };
  return { kind: "unsure", text };
}

/** A reply to "a question or a change?" that answers it. */
export function routeChoice(reply: string): "conversation" | "request" | null {
  const word = reply.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:ask|question|a question|answer|look it up|lookup)$/.test(word)) return "conversation";
  if (/^(?:change|a change|request|make a change|make the change|do it)$/.test(word)) return "request";
  return null;
}

// -- Which post a change is for ------------------------------------------------

/** A post named by number: "post 102", "page #45", "post ID 7", an editor link or ?p=102. A bare "#2" isn't one. */
export function mentionedPostId(text: string): number | null {
  const patterns = [
    /\b(?:post|page|article|draft)\s*(?:id\s*)?(?:no\.?\s*|number\s*)?#?\s*(\d{1,9})\b/i,
    /[?&](?:post|p|page_id)=(\d{1,9})\b/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Links in the message. Slack sends them as <https://…|label> or <https://…>. */
export function mentionedLinks(text: string): URL[] {
  const links: URL[] = [];
  for (const match of text.matchAll(/<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)/g)) {
    try {
      links.push(new URL(match[1] ?? match[2] ?? ""));
    } catch {
      // Not a link after all.
    }
  }
  return links;
}

/** "Write a post about…", "create a new page", "draft a post": new content, not an edit. */
export function wantsNewPost(text: string): boolean {
  return (
    /\b(?:new|fresh)\s+(?:blog\s+)?(?:post|page|article|draft)\b/i.test(text) ||
    /\b(?:create|write|draft|compose|start)\s+(?:me\s+|us\s+)?(?:a|an)\s+(?:[\w-]+\s+){0,3}?(?:post|page|article|draft|blog)\b/i.test(text)
  );
}

/** "the last post", "my latest page", "the most recent post". */
export function asksForLatest(text: string): "post" | "page" | null {
  const match = /\b(?:last|latest|newest|most recent|most recently created)\s+(?:created\s+|published\s+)?(post|page)\b/i.exec(text);
  return match ? (match[1]!.toLowerCase() as "post" | "page") : null;
}

/** The one post an answer was about ("post ID 102, titled Wibble"), if it names exactly one. */
export function onlyPostIdIn(answer: string): number | null {
  const ids = new Set([...answer.matchAll(/\b(?:post|page)\s*(?:id\s*)?#?\s*(\d{1,9})\b/gi)].map((match) => Number(match[1])));
  return ids.size === 1 ? [...ids][0]! : null;
}
