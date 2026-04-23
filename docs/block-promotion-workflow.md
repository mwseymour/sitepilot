# Block Promotion Workflow

## Purpose

Promote blocks from `indexed` to `executable` without inventing Gutenberg save
HTML.

## Promotion Gate

A block only becomes executable when all of the following exist:

1. Snapshot metadata is indexed from `wordpress-core/`.
2. A serializer strategy is chosen:
   - `standalone static`
   - `container`
   - `child-only`
   - `placement-restricted`
   - `dynamic/server`
3. Planner-side normalization exists in
   [packages/services/src/generate-action-plan.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/services/src/generate-action-plan.ts:1).
4. Plugin-side canonicalization exists in
   [plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php](/Users/mattseymour/Desktop/ai-dev/sitepilot/plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php:1).
5. Regression tests cover valid and invalid shapes.
6. The block is added to the executable allowlist.

## Role Order

Promote by structural role, not by user request frequency:

1. `Standalone`
2. `Container`
3. `Child-only`
4. `Placement-restricted`

## Per-Block Checklist

- Confirm indexed metadata:
  - attrs
  - supports
  - `allowedBlocks`
  - `parent`
  - `ancestor`
  - render/php files
- Decide canonical parsed-block input shape.
- Implement deterministic save markup generation.
- Reject incompatible block/content pairings.
- Add tests:
  - valid parsed block serializes correctly
  - malformed HTML is rewritten or rejected
  - placement rules are enforced where relevant
- Flip the block to executable.

## Current Batch

Standalone batch 1:

- `core/code`
- `core/preformatted`
- `core/quote`
- `core/separator`
- `core/verse`
