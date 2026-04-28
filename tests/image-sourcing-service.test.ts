import { afterEach, describe, expect, it, vi } from "vitest";

import { sourceImagesForActionPlan } from "../apps/desktop/src/main/image-sourcing-service.ts";

describe("image-sourcing-service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills missing image block urls with a verified sourced image", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://commons.wikimedia.org/w/api.php")) {
        return new Response(
          JSON.stringify({
            query: {
              pages: {
                "1": {
                  imageinfo: [
                    {
                      thumburl:
                        "https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/A_Golden_Retriever-9_%28Barras%29.JPG/1280px-A_Golden_Retriever-9_%28Barras%29.JPG",
                      mime: "image/jpeg"
                    }
                  ]
                }
              }
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      expect(init?.method).toBe("HEAD");
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "image/jpeg"
        }
      });
    }));

    const plan = await sourceImagesForActionPlan({
      plan: {
        id: "plan-1",
        requestId: "request-1",
        siteId: "site-1",
        requestSummary: "Add a dog image",
        assumptions: [],
        openQuestions: [],
        targetEntities: [],
        proposedActions: [
          {
            id: "action-1",
            type: "create_draft_post",
            version: 1,
            input: {
              title: "Dog page",
              blocks: [
                {
                  blockName: "core/image",
                  attrs: {
                    id: 0,
                    alt: "Golden retriever puppy"
                  },
                  innerBlocks: [],
                  innerHTML: "",
                  innerContent: []
                }
              ]
            },
            targetEntityRefs: [],
            permissionRequirement: "edit_posts",
            riskLevel: "low",
            dryRunCapable: true,
            rollbackSupported: false
          }
        ],
        dependencies: [],
        approvalRequired: false,
        riskLevel: "low",
        rollbackNotes: [],
        validationWarnings: [],
        createdAt: "2026-04-28T10:00:00.000Z",
        updatedAt: "2026-04-28T10:00:00.000Z"
      },
      requestText: "Add a golden retriever puppy image to the page.",
      hasAttachments: false
    });

    const action = plan.proposedActions[0];
    expect(action?.input).toMatchObject({
      blocks: [
        {
          attrs: {
            url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/A_Golden_Retriever-9_%28Barras%29.JPG/1280px-A_Golden_Retriever-9_%28Barras%29.JPG",
            alt: "Golden retriever puppy"
          }
        }
      ]
    });
  });
});
