import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reviewCardHtml } from "../packages/mcp-server/src/review-card.js";

/**
 * The review card in a real browser, inside a minimal MCP Apps host: it
 * connects, shows the previews, and its Approve button calls decide_from_card
 * with the card's ticket. Catches a package update that breaks the inlined
 * bundle.
 */

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("the review card", () => {
  it("renders the review and sends the person's click with its ticket", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(`<iframe id="card" style="width:700px;height:600px"></iframe>`);
    await page.evaluate(
      ({ html, png }) => {
        const frame = document.getElementById("card") as HTMLIFrameElement;
        const reply = (message: unknown) => frame.contentWindow?.postMessage(message, "*");
        window.addEventListener("message", (event) => {
          const message = event.data as { id?: number; method?: string; params?: Record<string, unknown> };
          if (message.method === "ui/initialize") {
            reply({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: message.params?.protocolVersion,
                hostInfo: { name: "test-host", version: "1" },
                hostCapabilities: { serverTools: {}, openLinks: {} },
                hostContext: {}
              }
            });
          } else if (message.method === "ui/notifications/initialized") {
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: {
                content: [{ type: "text", text: "Showing the review card." }],
                structuredContent: {
                  siteId: "site-1",
                  requestId: "thread-1",
                  title: "A Weekend in the Lake District",
                  state: "awaiting_approval",
                  stateLabel: "Ready for review",
                  summary: "Check the previews, then approve or reject.",
                  changes: ["New draft: “A Weekend in the Lake District”"],
                  previews: [
                    { id: "preview-0", label: "Desktop", url: png },
                    { id: "preview-1", label: "Mobile", url: png }
                  ]
                },
                _meta: { "sitepilot/approval": { ticket: "ticket-1234567890abcdef" } }
              }
            });
          } else if (message.method === "tools/call") {
            (window as unknown as { called: unknown }).called = message.params;
            reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Approved. SitePilot is applying it to the site now." }] } });
          }
        });
        frame.srcdoc = html;
      },
      { html: reviewCardHtml(), png: PNG }
    );
    const card = page.frameLocator("#card");
    await card.getByText("A Weekend in the Lake District", { exact: true }).waitFor({ timeout: 10_000 });
    expect(await card.locator("img").count()).toBe(2);
    await card.getByRole("button", { name: "Approve and apply" }).click();
    await card.getByText("Approved. SitePilot is applying it").waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => (window as unknown as { called: unknown }).called)).toMatchObject({
      name: "decide_from_card",
      arguments: { site_id: "site-1", request_id: "thread-1", ticket: "ticket-1234567890abcdef", decision: "approve" }
    });
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});
