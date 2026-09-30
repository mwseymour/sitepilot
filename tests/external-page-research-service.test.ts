import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sitepilot/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sitepilot/services")>()),
  safeFetch: vi.fn()
}));

import { safeFetch, SafeFetchError } from "@sitepilot/services";

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
    vi.mocked(safeFetch).mockResolvedValueOnce({
      url: "https://example.com/about",
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(
        "<html><head><title>Example About</title><style>.x{}</style></head><body><main><h1>About us</h1><p>We build sites.</p><script>bad()</script></main></body></html>"
      )
    });

    const page = await fetchExternalPageText("https://example.com/about");

    expect(page.title).toBe("Example About");
    expect(page.text).toContain("About us");
    expect(page.text).toContain("We build sites.");
    expect(page.text).not.toContain("bad()");
  });

  it("fetches through safeFetch, which allows http for public addresses only", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(
      new SafeFetchError(
        "address_not_allowed",
        "127.0.0.1 points to a private or local address, which SitePilot won't fetch."
      )
    );

    await expect(fetchExternalPageText("http://127.0.0.1:8765/")).rejects.toThrow(
      "private or local address"
    );
    expect(vi.mocked(safeFetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/",
      expect.objectContaining({ allowHttp: true, maxBytes: 2 * 1024 * 1024 })
    );
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
