# Reliable Gutenberg Block Generation

## Purpose

SitePilot must not rely on model-authored Gutenberg serialized HTML for complex post layouts. Gutenberg validates saved markup against the block's expected saved output, and small differences in wrappers, attributes, nesting, `innerContent`, or block comments can make WordPress show "Block contains unexpected or invalid content" or collapse content into a Classic block.

For layout, nested, media, and spacer content, the planner should emit structured parsed block arrays. The WordPress plugin validates, sanitizes, canonicalizes, and serializes those arrays inside the target WordPress install.

## Flow

1. The planner creates an action with `input.blocks` for complex Gutenberg content.
2. Desktop preserves `blocks` through action mapping and MCP execution.
3. The WordPress plugin validates and sanitizes the parsed block tree.
4. The plugin serializes the sanitized tree with WordPress core `serialize_blocks()`.
5. The resulting `post_content` is inserted or updated.

`blocks` always takes precedence over legacy `content` when both are supplied.

## Parsed Block Contract

The shared TypeScript schema lives in `@sitepilot/contracts`.

```ts
type ParsedBlock = {
  blockName: string;
  attrs: Record<string, unknown>;
  innerBlocks: ParsedBlock[];
  innerHTML: string;
  innerContent: Array<string | null>;
};
```

Core block names must use parsed block names such as:

```text
core/columns
core/column
core/paragraph
core/image
core/spacer
```

Do not use Gutenberg comment prefixes as parsed block names:

```text
wp:columns
wp:paragraph
```

If `wp:` names reach WordPress, core can serialize them as invalid comments such as `<!-- wp:wp:columns -->`.

## Important Gutenberg Detail

`serialize_blocks()` does not reconstruct static block save markup from `blockName`.

It serializes the supplied parsed block array. For nested blocks, parent `innerContent` must contain the wrapper HTML strings and `null` placeholders where each child block should be inserted.

Correct two-column shape:

```json
{
  "blockName": "core/columns",
  "attrs": {},
  "innerBlocks": [
    {
      "blockName": "core/column",
      "attrs": {},
      "innerBlocks": [
        {
          "blockName": "core/paragraph",
          "attrs": {},
          "innerBlocks": [],
          "innerHTML": "<p>Left text</p>",
          "innerContent": ["<p>Left text</p>"]
        }
      ],
      "innerHTML": "<div class=\"wp-block-column\"></div>",
      "innerContent": ["<div class=\"wp-block-column\">", null, "</div>"]
    },
    {
      "blockName": "core/column",
      "attrs": {},
      "innerBlocks": [
        {
          "blockName": "core/image",
          "attrs": {
            "id": 0,
            "url": "https://example.com/image.jpg",
            "alt": "Example image"
          },
          "innerBlocks": [],
          "innerHTML": "<figure class=\"wp-block-image\"><img src=\"https://example.com/image.jpg\" alt=\"Example image\"/></figure>",
          "innerContent": [
            "<figure class=\"wp-block-image\"><img src=\"https://example.com/image.jpg\" alt=\"Example image\"/></figure>"
          ]
        }
      ],
      "innerHTML": "<div class=\"wp-block-column\"></div>",
      "innerContent": ["<div class=\"wp-block-column\">", null, "</div>"]
    }
  ],
  "innerHTML": "<div class=\"wp-block-columns\">\n\n</div>",
  "innerContent": ["<div class=\"wp-block-columns\">", null, "\n\n", null, "</div>"]
}
```

The `null` entries are not optional. They are the insertion points for `innerBlocks`.

## Canonicalization

Desktop planner normalization is implemented in:

```text
packages/services/src/generate-action-plan.ts
```

The plugin-side validation and canonicalization is implemented in:

```text
plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php
```

The plugin is the final safety boundary. Even if the model emits malformed-but-recoverable shapes, the plugin should canonicalize common core blocks before serialization.

Current canonicalization covers:

- `core/columns`
- `core/column`
- `core/paragraph`
- `core/heading`
- `core/image`
- `core/spacer`
- accidental `wp:` or `core:` block name prefixes

Unknown valid block names are not blocked by allowlist in v1, but malformed structure is rejected.

## Plugin Validation Rules

When `blocks` is supplied:

- `blocks` must be a non-empty array.
- each block node must be an array/object.
- `blockName` must be a string.
- `attrs` must be an array/object.
- `innerBlocks` must be an array.
- `innerHTML` must be a string.
- `innerContent` must be an array.
- `innerContent` entries must be strings or `null`.
- nested blocks are validated recursively.

Malformed input returns `ok: false`, for example:

```text
invalid_blocks: blocks[0].innerContent must be an array
```

The plugin must not silently drop bad block nodes or fall back to `content` when `blocks` is malformed.

## Sanitization Rules

- `blockName` is normalized and sanitized.
- string attrs are sanitized with `sanitize_text_field`.
- `innerHTML` and string `innerContent` chunks are sanitized with `wp_kses_post`.
- `null` placeholders in `innerContent` are preserved.
- nested blocks are sanitized recursively.

## Images

For external images, the model/planner can use `id: 0` because the file is not in the Media Library.

Example:

```json
{
  "blockName": "core/image",
  "attrs": {
    "id": 0,
    "url": "https://upload.wikimedia.org/wikipedia/commons/b/be/Chinon_CP_9_AF_BW_1.JPG",
    "alt": "Random image"
  },
  "innerBlocks": [],
  "innerHTML": "<figure class=\"wp-block-image\"><img src=\"https://upload.wikimedia.org/wikipedia/commons/b/be/Chinon_CP_9_AF_BW_1.JPG\" alt=\"Random image\"/></figure>",
  "innerContent": [
    "<figure class=\"wp-block-image\"><img src=\"https://upload.wikimedia.org/wikipedia/commons/b/be/Chinon_CP_9_AF_BW_1.JPG\" alt=\"Random image\"/></figure>"
  ]
}
```

The plugin rejects non-HTTPS media URLs in media-like block attrs containing `url` or `src`.

Before using a model-selected external image URL, check that it actually returns an image:

```sh
curl -I -L 'https://upload.wikimedia.org/wikipedia/commons/b/be/Chinon_CP_9_AF_BW_1.JPG'
```

The response should be `2xx` and `content-type` should start with `image/`. A valid Gutenberg image block with a broken external URL will still render as a broken image in the editor.

## Failure Modes We Hit

### Invalid Wrapper `innerContent`

Bad parent block:

```json
{
  "blockName": "core/columns",
  "innerBlocks": [{ "...": "..." }, { "...": "..." }],
  "innerContent": [null, null]
}
```

This serializes child blocks, but without the `wp-block-columns` wrapper Gutenberg expects. The editor can show "Attempt recovery".

Correct parent block:

```json
{
  "blockName": "core/columns",
  "innerContent": ["<div class=\"wp-block-columns\">", null, "\n\n", null, "</div>"]
}
```

### `wp:` Parsed Block Names

Bad parsed block:

```json
{ "blockName": "wp:columns" }
```

This can serialize as:

```html
<!-- wp:wp:columns -->
```

Gutenberg does not treat that as the core Columns block.

Correct parsed block:

```json
{ "blockName": "core/columns" }
```

### Broken External Image URLs

A recent generated URL was:

```text
https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Image_created_with_a_small_camera.jpg/640px-Image_created_with_a_small_camera.jpg
```

It returned `HTTP/2 400`, so WordPress showed a broken image even though the block structure was valid.

## Debugging Latest MCP Payload

The desktop stores tool invocations in the local SQLite database.

```sh
sqlite3 "$HOME/Library/Application Support/@sitepilot/desktop/sitepilot.sqlite" \
  "select ur.id, ur.user_prompt, er.id, ti.id, ti.input_json, ti.output_json
   from requests ur
   join execution_runs er on er.id = ur.latest_execution_run_id
   join tool_invocations ti on ti.execution_run_id = er.id
   where ti.tool_name='sitepilot-create-draft-post'
   order by er.created_at desc
   limit 3;"
```

Look at:

- `ti.input_json` for the exact planner/MCP payload.
- `ti.output_json.after.post_content` for the plugin's final serialized content.

The chat developer tools also show:

- planned action input
- last MCP call input/output

## Tests

Run the focused TypeScript coverage:

```sh
npm test -- generate-action-plan mcp-action-map contracts-schemas ipc-contracts
```

Run the plugin PHPUnit coverage:

```sh
cd plugins/wordpress-sitepilot
composer test
```

The plugin tests include a regression for `wp:`-prefixed parsed block names and ensure the output does not contain `wp:wp:`.

## Future Work

The current v1 contract accepts parsed block arrays because it maps directly to WordPress `serialize_blocks()`.

A better v2 would define a simpler internal SitePilot block AST and convert it deterministically to parsed block arrays before sending to the plugin. That would reduce model responsibility further and make it easier to guarantee correct `innerContent` for more core blocks.
