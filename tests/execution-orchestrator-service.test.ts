import { afterEach, describe, expect, it, vi } from "vitest";

import { __testables } from "../apps/desktop/src/main/execution-orchestrator-service.ts";

describe("execution-orchestrator-service external media localization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects external image references from parsed image blocks", () => {
    const refs = __testables.extractExternalImageReferencesFromBlocks([
      {
        blockName: "core/image",
        attrs: {
          id: 0,
          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/RedDot_Burger.jpg/640px-RedDot_Burger.jpg",
          alt: "A burger on a plate"
        },
        innerBlocks: [],
        innerHTML: "",
        innerContent: []
      }
    ]);

    expect(refs).toEqual([
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/RedDot_Burger.jpg/640px-RedDot_Burger.jpg",
        altText: "A burger on a plate"
      }
    ]);
  });

  it("downloads external image urls into uploadable attachments", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "image/jpeg"
          }
        });
      }

      return new Response(Buffer.from("fake-image"), {
        status: 200,
        headers: {
          "content-type": "image/jpeg"
        }
      });
    }));

    const result = await __testables.collectMediaAttachmentsForSpec({
      requestAttachments: undefined,
      spec: {
        toolName: "sitepilot-create-draft-post",
        arguments: {
          blocks: [
            {
              blockName: "core/image",
              attrs: {
                id: 0,
                url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/RedDot_Burger.jpg/640px-RedDot_Burger.jpg",
                alt: "A burger on a plate"
              },
              innerBlocks: [],
              innerHTML: "",
              innerContent: []
            }
          ]
        }
      },
      siteBaseUrl: "https://test.localhost:8890",
      requestText: "Add a burger image to the page."
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      fileName: "640px-RedDot_Burger.jpg",
      mediaType: "image/jpeg"
    });
    expect(result.attachments[0]?.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(
      true
    );
  });

  it("collects missing media-text image references from serialized content", () => {
    const refs = __testables.extractExternalImageReferencesFromSerializedContent(
      '<!-- wp:media-text {"mediaType":"image","mediaAlt":"Team collaboration"} --><div class="wp-block-media-text"><figure class="wp-block-media-text__media"></figure><div class="wp-block-media-text__content"><p>Body copy.</p></div></div><!-- /wp:media-text -->'
    );

    expect(refs).toEqual([
      {
        altText: "Team collaboration"
      }
    ]);
  });
});
