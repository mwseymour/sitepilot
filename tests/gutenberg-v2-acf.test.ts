import { describe, expect, it, vi } from "vitest";

import {
  GutenbergV2AcfDataError,
  gutenbergV2AcfBlockDefinitionSchema,
  gutenbergV2AcfDataFromFields,
  gutenbergV2AcfSampleFields,
  gutenbergV2BlockPlanSchema,
  gutenbergV2SupportPolicy,
  type GutenbergV2AcfBlockDefinition,
  type GutenbergV2EditorCapabilitySnapshot
} from "@sitepilot/contracts";
import { buildLlmGutenbergV2Plan } from "@sitepilot/services";

// The playground site's container block, as the plugin describes it.
const container: GutenbergV2AcfBlockDefinition =
  gutenbergV2AcfBlockDefinitionSchema.parse({
    name: "acf/container",
    title: "Container",
    description: "A simple Container block.",
    mode: "preview",
    defaultAlign: "",
    innerBlocks: true,
    allowedBlocks: [],
    parent: [],
    ancestor: [],
    usePostMeta: false,
    supports: { align: true, anchor: false, multiple: true },
    fields: [
      {
        key: "field_container_colour",
        name: "colour",
        label: "Colour",
        type: "select",
        required: false,
        default: "white",
        choices: [
          { value: "bg-white", label: "white" },
          { value: "bg-gray-300", label: "grey" },
          { value: "bg-brand-accent", label: "brand accent" }
        ],
        multiple: false,
        allowNull: false
      },
      {
        key: "field_container_padding_amount",
        name: "padding_amount",
        label: "Padding Amount",
        type: "select",
        required: false,
        default: "normal",
        choices: [
          { value: "py-0", label: "none" },
          { value: "py-[80px] md:py-[100px]", label: "normal" }
        ]
      },
      {
        key: "field_container_bottom_border",
        name: "bottom_border",
        label: "Bottom Border",
        type: "true_false",
        required: false,
        default: 1
      }
    ],
    schemaHash: "a".repeat(64),
    authorable: true
  });

const withRepeater: GutenbergV2AcfBlockDefinition = {
  ...container,
  name: "acf/process-tree",
  fields: [
    {
      key: "field_items",
      name: "items",
      label: "Items",
      type: "repeater",
      required: true,
      subFields: [
        {
          key: "field_item_title",
          name: "title",
          label: "Title",
          type: "text",
          required: true
        },
        {
          key: "field_item_link",
          name: "link",
          label: "Link",
          type: "link",
          required: false
        }
      ]
    }
  ]
};

describe("ACF block data", () => {
  it("stores field values the way ACF does, with defaults and choice labels resolved", () => {
    expect(gutenbergV2AcfDataFromFields(container, { colour: "grey" })).toEqual(
      {
        colour: "bg-gray-300",
        _colour: "field_container_colour",
        padding_amount: "py-[80px] md:py-[100px]",
        _padding_amount: "field_container_padding_amount",
        bottom_border: "1",
        _bottom_border: "field_container_bottom_border"
      }
    );
  });

  it("keeps an edit to the fields it names", () => {
    expect(
      gutenbergV2AcfDataFromFields(
        container,
        { Colour: "brand accent" },
        { partial: true }
      )
    ).toEqual({ colour: "bg-brand-accent", _colour: "field_container_colour" });
  });

  it("flattens repeater rows into ACF's row keys", () => {
    expect(
      gutenbergV2AcfDataFromFields(withRepeater, {
        items: [
          {
            title: "First",
            link: { title: "Read", url: "https://example.test/a" }
          },
          { title: "Second" }
        ]
      })
    ).toEqual({
      items: "2",
      _items: "field_items",
      items_0_title: "First",
      _items_0_title: "field_item_title",
      items_0_link: {
        title: "Read",
        url: "https://example.test/a",
        target: ""
      },
      _items_0_link: "field_item_link",
      items_1_title: "Second",
      _items_1_title: "field_item_title"
    });
  });

  it("rejects values that do not fit the site's fields", () => {
    const attempt = () =>
      gutenbergV2AcfDataFromFields(container, {
        colour: "purple",
        width: "full"
      });
    expect(attempt).toThrow(GutenbergV2AcfDataError);
    expect(attempt).toThrow(/colour must be one of: bg-white \(white\)/);
    expect(attempt).toThrow(/no field "width"/);
    expect(() => gutenbergV2AcfDataFromFields(withRepeater, {})).toThrow(
      /items is required/
    );
    expect(() =>
      gutenbergV2AcfDataFromFields(withRepeater, {
        items: [{ title: "x", link: { url: "javascript:alert(1)" } }]
      })
    ).toThrow(/link must be/);
  });

  it("builds fixture values that fit every field", () => {
    const sample = gutenbergV2AcfSampleFields(
      withRepeater,
      "https://example.test/"
    );
    expect(() =>
      gutenbergV2AcfDataFromFields(withRepeater, sample)
    ).not.toThrow();
  });
});

describe("ACF block nodes", () => {
  function draft(node: unknown) {
    return {
      schemaVersion: "sitepilot.block-plan/v2" as const,
      planId: "plan-1",
      siteId: "site-1",
      operation: "create_draft" as const,
      target: { postType: "page" as const },
      postFields: { title: "Draft", status: "draft" as const },
      blocks: [node],
      media: []
    };
  }

  it("accepts any ACF block in stored shape, with core children", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft({
          ref: "c",
          name: "acf/container",
          attributes: {
            name: "acf/container",
            data: gutenbergV2AcfDataFromFields(container, {}),
            align: "",
            mode: "preview"
          },
          children: [
            {
              ref: "p",
              name: "core/paragraph",
              attributes: { content: "Inside" },
              children: []
            }
          ]
        })
      )
    ).not.toThrow();
  });

  it("rejects a mismatched name or loose attributes", () => {
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft({
          ref: "c",
          name: "acf/container",
          attributes: { name: "acf/other", data: {} },
          children: []
        })
      )
    ).toThrow(/attributes.name must be acf\/container/);
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(
        draft({
          ref: "c",
          name: "acf/container",
          attributes: { name: "acf/container", data: {}, colour: "grey" },
          children: []
        })
      )
    ).toThrow();
  });

  it("gates every ACF block behind a per-site fixture", () => {
    expect(gutenbergV2SupportPolicy("acf/anything")).toMatchObject({
      mode: "fixture_required"
    });
    expect(gutenbergV2SupportPolicy("core/paragraph")?.mode).toBe("author");
    expect(gutenbergV2SupportPolicy("acme/widget")).toBeUndefined();
  });
});

describe("planning with ACF blocks", () => {
  function capabilities(): GutenbergV2EditorCapabilitySnapshot {
    const block = {
      registered: true,
      allowed: true,
      dynamic: false,
      attributeSchemaHash: "4".repeat(64),
      allowedParents: [],
      allowedAncestors: [],
      allowedChildren: [],
      supportsHtml: false,
      lock: "none" as const
    };
    return {
      schemaVersion: "sitepilot.editor-capabilities/v2",
      siteId: "site-1",
      siteUrl: "https://example.test",
      bridgeVersion: "2.0.0",
      wordpressVersion: "7.1.1",
      fingerprint: "1".repeat(64),
      capturedAt: "2026-09-22T12:00:00.000Z",
      context: {
        postType: "page",
        userId: 7,
        userRoles: ["editor"],
        theme: "totally-starter",
        pluginFingerprint: "2".repeat(64),
        editorSettingsFingerprint: "3".repeat(64)
      },
      blocks: [
        { ...block, name: "core/paragraph", v2Support: "author" },
        {
          ...block,
          name: "acf/container",
          v2Support: "author_when_reviewed",
          dynamic: true,
          acf: container
        }
      ]
    };
  }

  it("describes the site's fields to the model and stores its answer as ACF data", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        postFields: { title: "Grey box" },
        blocks: [
          {
            ref: "box",
            name: "acf/container",
            attributes: { fields: { colour: "grey", bottom_border: false } },
            children: [
              {
                ref: "p",
                name: "core/paragraph",
                attributes: { content: "Inside" },
                children: []
              }
            ]
          }
        ]
      }),
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const result = await buildLlmGutenbergV2Plan({
      request: "A grey container with a paragraph.",
      siteId: "site-1",
      target: { operation: "create_draft", postType: "page" },
      capabilities: capabilities(),
      client: { providerId: "test", complete },
      model: "test"
    });
    const system = (
      complete.mock.calls[0] as unknown as [Array<{ content: string }>]
    )[0][0]!.content;
    expect(system).toContain("acf/container: a site-specific ACF block");
    expect(system).toContain("colour (select)");
    expect(system).toContain("bg-gray-300 (grey)");
    if (result.plan.operation !== "create_draft")
      throw new Error("Expected a draft.");
    expect(result.plan.blocks[0]!.attributes).toEqual({
      name: "acf/container",
      data: {
        colour: "bg-gray-300",
        _colour: "field_container_colour",
        padding_amount: "py-[80px] md:py-[100px]",
        _padding_amount: "field_container_padding_amount",
        bottom_border: "0",
        _bottom_border: "field_container_bottom_border"
      },
      align: "",
      mode: "preview"
    });
  });

  it("sends field mistakes back to the model once", async () => {
    const answers = [{ colour: "purple" }, { colour: "brand accent" }];
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        postFields: { title: "Box" },
        blocks: [
          {
            ref: "box",
            name: "acf/container",
            attributes: { fields: answers.shift() },
            children: []
          }
        ]
      }),
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const result = await buildLlmGutenbergV2Plan({
      request: "A purple container.",
      siteId: "site-1",
      target: { operation: "create_draft", postType: "page" },
      capabilities: capabilities(),
      client: { providerId: "test", complete },
      model: "test"
    });
    expect(complete).toHaveBeenCalledTimes(2);
    const repair = (
      complete.mock.calls[1] as unknown as [Array<{ content: string }>]
    )[0][1]!.content;
    expect(repair).toContain("colour must be one of");
    if (result.plan.operation !== "create_draft")
      throw new Error("Expected a draft.");
    expect(result.plan.blocks[0]!.attributes).toMatchObject({
      data: { colour: "bg-brand-accent" }
    });
  });
});
