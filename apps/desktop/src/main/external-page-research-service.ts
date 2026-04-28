type ExtractedPage = {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
};

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const REQUEST_HANDOFF_RE =
  /\b(new request|use in (?:a )?new request|use for (?:a )?new request|turn (?:this|it) into (?:a )?new request|create (?:a )?new request)\b/i;
const PAGE_FETCH_RE =
  /\b(get|fetch|extract|pull|grab|use|summari[sz]e|read|review)\b.*\b(text|content|copy|page|link|url|article|web page|webpage)\b/i;
const PAGE_REFERENCE_RE =
  /\b(page|link|url|article|web page|webpage|site)\b/i;
const MAX_EXTRACTED_TEXT_LENGTH = 12_000;

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    });
}

function collapseParagraphs(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return null;
  }
  return collapseParagraphs(decodeHtmlEntities(match[1].replace(/\s+/g, " ")));
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  const mainContentMatch =
    withoutNoise.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    withoutNoise.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    withoutNoise.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const content = mainContentMatch?.[1] ?? withoutNoise;

  const withBreaks = content
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|aside|header|footer|li|ul|ol|h[1-6]|blockquote|pre|table|tr)>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return collapseParagraphs(decodeHtmlEntities(stripped));
}

function safeHostname(url: URL): string {
  return url.hostname.replace(/^www\./i, "");
}

function buildRequestTitle(page: ExtractedPage): string {
  const source = page.title.trim().length > 0 ? page.title.trim() : safeHostname(new URL(page.url));
  const truncated = source.length > 120 ? `${source.slice(0, 117).trimEnd()}...` : source;
  return `Research: ${truncated}`;
}

export function parseExternalResearchIntent(text: string): {
  url: string;
  shouldCreateRequest: boolean;
} | null {
  const url = text.match(URL_RE)?.[0];
  if (!url) {
    return null;
  }

  const mentionsFetch =
    PAGE_FETCH_RE.test(text) ||
    /\btext\b/i.test(text) ||
    (/\bsummari[sz]e\b/i.test(text) && PAGE_REFERENCE_RE.test(text));
  const shouldCreateRequest = REQUEST_HANDOFF_RE.test(text);
  if (!mentionsFetch && !shouldCreateRequest) {
    return null;
  }

  return {
    url,
    shouldCreateRequest
  };
}

export async function fetchExternalPageText(urlText: string): Promise<ExtractedPage> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    throw new Error("That link is not a valid URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only http and https links are supported for research fetches.");
  }

  const response = await fetch(parsedUrl.toString(), {
    headers: {
      accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch the page (${response.status}).`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html") && !contentType.startsWith("text/plain")) {
    throw new Error("That link did not return an HTML or plain text page.");
  }

  const rawText = await response.text();
  const title =
    contentType.includes("text/html")
      ? extractHtmlTitle(rawText)
      : null;
  const extracted =
    contentType.includes("text/html") ? htmlToText(rawText) : collapseParagraphs(rawText);
  if (extracted.length === 0) {
    throw new Error("I fetched the page, but could not extract readable text from it.");
  }

  const truncated = extracted.length > MAX_EXTRACTED_TEXT_LENGTH;
  return {
    url: response.url || parsedUrl.toString(),
    title: title && title.length > 0 ? title : safeHostname(parsedUrl),
    text: truncated ? `${extracted.slice(0, MAX_EXTRACTED_TEXT_LENGTH).trimEnd()}...` : extracted,
    truncated
  };
}

export function buildExternalPageRequestPrompt(input: {
  operatorText: string;
  page: ExtractedPage;
}): string {
  return [
    "Use this external page as source material for a new site request.",
    "",
    `Source URL: ${input.page.url}`,
    `Page title: ${input.page.title}`,
    "",
    `Operator instruction: ${input.operatorText.trim()}`,
    "",
    "Extracted page text:",
    input.page.text
  ].join("\n");
}

export function buildExternalPageReply(input: {
  page: ExtractedPage;
  createdRequestTitle?: string;
}): string {
  const preview = input.page.text.slice(0, 600).trimEnd();
  const previewSuffix =
    input.page.text.length > preview.length ? "..." : "";

  if (input.createdRequestTitle) {
    return [
      `Fetched ${input.page.title} and created a new request thread: ${input.createdRequestTitle}.`,
      "Open Requests to review it and generate a plan.",
      "",
      `Source: ${input.page.url}`,
      input.page.truncated
        ? "The extracted text was truncated before being attached to the request."
        : "The extracted text was attached to the request in full.",
      "",
      `Preview:\n${preview}${previewSuffix}`
    ].join("\n");
  }

  return [
    `Fetched ${input.page.title}.`,
    `Source: ${input.page.url}`,
    input.page.truncated
      ? "The extracted text was truncated for this preview."
      : "Extracted text preview:",
    "",
    `${preview}${previewSuffix}`
  ].join("\n");
}

export { buildRequestTitle as buildExternalPageRequestTitle };
