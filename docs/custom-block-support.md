# Custom Block Support

SitePilot discovers third-party Gutenberg blocks during site discovery, but it only writes custom blocks after they have been explicitly loaded into SitePilot's support registry.

Discovery records all non-core registered blocks in `third_party_blocks`. ACF blocks are then classified into `sections.contentModel.customBlockSupport` when a site config draft is generated:

- `passthrough`: SitePilot may write the block on sites where discovery found it.
- `manual_review_required`: SitePilot found an ACF-like block but does not yet have a reviewed schema and serialization contract for it.
- `attributes`: optional discovered field metadata for the block, including selectable option labels and values. Reindexing the site refreshes these values.

## Current Loaded Custom Blocks

- `acf/container`: passthrough support. Use parsed block form with `blockName: "acf/container"`, ACF Composer attrs in `attrs`, child blocks in `innerBlocks`, empty `innerHTML`, and `innerContent` null placeholders for children. Do not invent wrapper HTML such as `<div class="acf-container">`; WordPress/ACF renders the block from the parsed block comment and child placeholders.

## Loading A New Custom Block

Use this process when discovery shows a block such as `acf/button-brand` or `acf/accordion` and SitePilot needs to write it.

1. Confirm the block is registered on the target site.

   Run discovery and check the generated site config. The block must appear in `sections.contentModel.thirdPartyBlocks`. If it does not, the WordPress site is not registering it for the editor context SitePilot can see.

2. Capture a canonical example from WordPress.

   In the block editor, create a minimal post using the custom block and inspect the saved `post_content`. Record the block comment, attrs JSON, wrapper HTML, child block placement, and whether the block is dynamic.

3. Define the parsed block contract.

   Document the exact JSON shape SitePilot should send:

   ```json
   {
     "blockName": "acf/example",
     "attrs": {},
     "innerBlocks": [],
     "innerHTML": "",
     "innerContent": []
   }
   ```

   Include required attrs, optional attrs, allowed child blocks, whether `innerHTML` should be empty, and how many `null` placeholders `innerContent` needs. For custom blocks with children, `innerContent` must contain one `null` placeholder per child block in the exact serialization order.

   For `acf/container`, the minimum parsed shape is:

   ```json
   {
     "blockName": "acf/container",
     "attrs": {
       "name": "acf/container",
       "data": {},
       "align": "",
       "mode": "preview"
     },
     "innerBlocks": [
       {
         "blockName": "core/paragraph",
         "attrs": {},
         "innerBlocks": [],
         "innerHTML": "<p>Example content.</p>",
         "innerContent": ["<p>Example content.</p>"]
       }
     ],
     "innerHTML": "",
     "innerContent": [null]
   }
   ```

   Do not hard-code site-specific option values in planner code. If a user says "grey", resolve that label through the discovered `customBlockSupport.attributes[].options` values from the active site config. If the theme later changes the grey value, reindexing should update the stored option value.

4. Choose the support mode.

   Use `passthrough` only when WordPress can serialize the parsed block safely from attrs, `innerBlocks`, `innerHTML`, and `innerContent` without SitePilot inventing save HTML. If the block needs generated wrapper HTML, add explicit canonicalization in the WordPress plugin instead of passthrough.

5. Add the registry entry.

   Update `SUPPORTED_WORDPRESS_CUSTOM_BLOCKS` in `packages/contracts/src/core-block-support.ts` with the block name, support mode, reason, and schema notes.

6. Confirm discovery captures selectable attrs.

   For ACF blocks, `sitepilot/site-discovery` should expose select/radio/button/checkbox field choices under the block's `attributes` array. Confirm the generated site config preserves these under `sections.contentModel.customBlockSupport[].attributes`.

7. Update the plugin allowlist.

   Add the block name to `supported_custom_passthrough_blocks()` in `plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php`. If passthrough is not enough, add a block-specific canonicalizer in `sanitize_parsed_block()`.

8. Add tests.

   Add contract tests for discovery classification, discovered attributes, and unsupported-block validation. Add planner tests if the block needs prompt instructions or label-to-value option resolution. Add plugin tests that prove the block serializes correctly and that similar unreviewed blocks remain blocked.

9. Verify against a real WordPress site.

   Run the relevant E2E suite, then create/update a draft using the custom block. Open the post in the editor and confirm the block is valid, editable, and does not trigger block recovery.

## Guardrails

- Do not add all discovered ACF blocks automatically.
- Do not rewrite custom block names as `core/...`; use the registered namespace, such as `acf/container`.
- Do not use `input.content` for custom block markup unless the block has a documented serialized-content path. Prefer parsed `input.blocks`.
- Do not invent custom-block saved HTML wrappers. If the canonical saved post content includes wrapper HTML, document where it comes from and add a block-specific canonicalizer before enabling writes.
- For child-capable custom blocks, validate in WordPress editor that the block does not show "unexpected or invalid content" after saving and reopening.
- Keep discovered blocks and loaded blocks separate. Discovery means SitePilot saw the block; loaded support means SitePilot may write it.
