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
