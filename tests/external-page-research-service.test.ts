import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildExternalPageRequestPrompt,
  fetchExternalPageText,
  parseExternalResearchIntent
} from "../apps/desktop/src/main/external-page-research-service.js";

describe("external page research service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects request handoff intent from a pasted link", () => {
    expect(
      parseExternalResearchIntent(
        "Get me the text from https://example.com/about to use in a new request."
      )
    ).toEqual({
      url: "https://example.com/about",
      shouldCreateRequest: true
    });
  });

  it("detects summarize prompts for external pages", () => {
    expect(
      parseExternalResearchIntent(
        "summarise this page https://github.com/openai/codex/issues/18258"
      )
    ).toEqual({
      url: "https://github.com/openai/codex/issues/18258",
      shouldCreateRequest: false
    });
  });

  it("detects simple text extraction prompts", () => {
    expect(
      parseExternalResearchIntent(
        "Get me the text from https://test.localhost:8890/big-beefy-boys/"
      )
    ).toEqual({
      url: "https://test.localhost:8890/big-beefy-boys/",
      shouldCreateRequest: false
    });
  });

  it("extracts readable text from html pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        url: "https://example.com/about",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null
        },
        text: async () =>
          "<html><head><title>Example About</title><style>.x{}</style></head><body><main><h1>About us</h1><p>We build sites.</p><script>bad()</script></main></body></html>"
      }))
    );

    const page = await fetchExternalPageText("https://example.com/about");

    expect(page.title).toBe("Example About");
    expect(page.text).toContain("About us");
    expect(page.text).toContain("We build sites.");
    expect(page.text).not.toContain("bad()");
  });

  it("builds a request prompt that preserves source provenance", () => {
    const prompt = buildExternalPageRequestPrompt({
      operatorText: "Use this in a new request.",
      page: {
        url: "https://example.com/about",
        title: "Example About",
        text: "We build sites.",
        truncated: false
      }
    });

    expect(prompt).toContain("Source URL: https://example.com/about");
    expect(prompt).toContain("Page title: Example About");
    expect(prompt).toContain("Extracted page text:");
  });
});
