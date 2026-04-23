import { describe, expect, it } from "vitest";

import {
  actionPlanSchema,
  auditEntrySchema,
  parsedBlockSchema,
  siteConfigSchema,
  signedRequestHeadersSchema
} from "@sitepilot/contracts";

describe("contracts schemas", () => {
  it("accepts a valid site config payload", () => {
    const parsed = siteConfigSchema.parse({
      id: "config-1",
      siteId: "site-1",
      version: 1,
      requiredSectionsComplete: true,
      activationStatus: "active",
      sections: {
        identity: {
          siteName: "Example Site",
          baseUrl: "https://example.com",
          businessDescription: "Mortgage broker website",
          audienceSummary: "Home buyers in the UK"
        },
        structure: {
          publicSections: ["Home", "Services"],
          restrictedTemplates: ["Landing Page"],
          pageTreeSummary: "Home > Services > Equity Release"
        },
        contentModel: {
          editablePostTypes: ["page", "post"],
          readOnlyPostTypes: ["acf-field-group"],
          taxonomyDefinitions: ["category", "topic"],
          thirdPartyBlocks: ["acf/testimonial", "gravityforms/form"]
        },
        seoPolicy: {
          titlePatterns: ["{Page Title} | Example Site"],
          redirectsRequireApproval: true,
          internalLinkingExpectation: "Link to relevant service pages"
        },
        mediaPolicy: {
          acceptedFormats: ["image/jpeg", "image/png"],
          altTextRequired: true,
          featuredImageRequiredPostTypes: ["post"]
        },
        approvalPolicy: {
          autoApproveCategories: ["draft_content_update"],
          publishRequiresApproval: true,
          menuChangesRequireApproval: true
        },
        toolAccessPolicy: {
          enabledTools: ["content.create", "content.update"],
          disabledTools: ["menu.update"],
          dryRunOnlyTools: ["seo.set_meta"]
        },
        contentStylePolicy: {
          tone: "Professional",
          readingLevel: "General consumer",
          disallowedWording: ["guaranteed approval"]
        },
        guardrails: {
          neverEditPages: ["homepage"],
          neverModifyMenuAutomatically: true,
          neverPublishWithoutApproval: true
        }
      },
      metadata: {
        notes: ["Initial draft from discovery"]
      },
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:00:00.000Z"
    });

    expect(parsed.sections.identity.siteName).toBe("Example Site");
  });

  it("accepts a legacy site config payload without third-party blocks", () => {
    const parsed = siteConfigSchema.parse({
      id: "config-legacy-1",
      siteId: "site-1",
      version: 1,
      requiredSectionsComplete: true,
      activationStatus: "active",
      sections: {
        identity: {
          siteName: "Example Site",
          baseUrl: "https://example.com",
          businessDescription: "Mortgage broker website",
          audienceSummary: "Home buyers in the UK"
        },
        structure: {
          publicSections: ["Home", "Services"],
          restrictedTemplates: ["Landing Page"],
          pageTreeSummary: "Home > Services > Equity Release"
        },
        contentModel: {
          editablePostTypes: ["page", "post"],
          readOnlyPostTypes: ["acf-field-group"],
          taxonomyDefinitions: ["category", "topic"]
        },
        seoPolicy: {
          titlePatterns: ["{Page Title} | Example Site"],
          redirectsRequireApproval: true,
          internalLinkingExpectation: "Link to relevant service pages"
        },
        mediaPolicy: {
          acceptedFormats: ["image/jpeg", "image/png"],
          altTextRequired: true,
          featuredImageRequiredPostTypes: ["post"]
        },
        approvalPolicy: {
          autoApproveCategories: ["draft_content_update"],
          publishRequiresApproval: true,
          menuChangesRequireApproval: true
        },
        toolAccessPolicy: {
          enabledTools: ["content.create", "content.update"],
          disabledTools: ["menu.update"],
          dryRunOnlyTools: ["seo.set_meta"]
        },
        contentStylePolicy: {
          tone: "Professional",
          readingLevel: "General consumer",
          disallowedWording: ["guaranteed approval"]
        },
        guardrails: {
          neverEditPages: ["homepage"],
          neverModifyMenuAutomatically: true,
          neverPublishWithoutApproval: true
        }
      },
      metadata: {
        notes: ["Initial draft from discovery"]
      },
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:00:00.000Z"
    });

    expect(parsed.sections.contentModel.thirdPartyBlocks).toEqual([]);
  });

  it("accepts a valid action plan payload", () => {
    const parsed = actionPlanSchema.parse({
      id: "plan-1",
      requestId: "request-1",
      siteId: "site-1",
      requestSummary: "Create a draft service page",
      assumptions: ["Page should stay in draft"],
      openQuestions: [],
      targetEntities: ["site:site-1"],
      proposedActions: [
        {
          id: "action-1",
          type: "content.create",
          version: 1,
          input: {
            postType: "page",
            title: "Equity Release"
          },
          targetEntityRefs: ["site:site-1"],
          permissionRequirement: "can_edit_pages",
          riskLevel: "medium",
          dryRunCapable: true,
          rollbackSupported: true
        }
      ],
      dependencies: [],
      approvalRequired: true,
      riskLevel: "medium",
      rollbackNotes: ["Store previous slug if publishing later"],
      validationWarnings: [],
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:00:00.000Z"
    });

    expect(parsed.proposedActions).toHaveLength(1);
  });

  it("accepts audit and signed request payloads", () => {
    const auditEntry = auditEntrySchema.parse({
      id: "audit-1",
      siteId: "site-1",
      eventType: "plan_generated",
      actor: {
        kind: "assistant"
      },
      metadata: {
        requestId: "request-1"
      },
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:00:00.000Z"
    });

    const headers = signedRequestHeadersSchema.parse({
      "x-sitepilot-request-id": "request-1",
      "x-sitepilot-site-id": "site-1",
      "x-sitepilot-client-id": "desktop-client-1",
      "x-sitepilot-timestamp": "2026-04-19T12:00:00.000Z",
      "x-sitepilot-nonce": "1234567890ab",
      "x-sitepilot-signature": "a".repeat(64),
      "x-sitepilot-payload-sha256": "b".repeat(64)
    });

    expect(auditEntry.eventType).toBe("plan_generated");
    expect(headers["x-sitepilot-client-id"]).toBe("desktop-client-1");
  });

  it("accepts recursive parsed Gutenberg block payloads", () => {
    const parsed = parsedBlockSchema.parse({
      blockName: "core/columns",
      attrs: {},
      innerBlocks: [
        {
          blockName: "core/column",
          attrs: { width: "50%" },
          innerBlocks: [
            {
              blockName: "core/paragraph",
              attrs: {},
              innerBlocks: [],
              innerHTML: "<p>Left text</p>",
              innerContent: ["<p>Left text</p>"]
            }
          ],
          innerHTML: "",
          innerContent: [null]
        }
      ],
      innerHTML: "",
      innerContent: [null]
    });

    expect(parsed.innerBlocks[0]?.innerBlocks[0]?.blockName).toBe(
      "core/paragraph"
    );
  });
});
