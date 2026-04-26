# Chat And Execution Regression Guardrails

This document records the dry-run regressions seen across the SitePilot chat flow and the layered fixes that now protect against them. The goal is simple: future planner or execution work must not reintroduce silent content corruption or ambiguous follow-up behavior.

## Why this exists

The same operator workflow was exercised repeatedly:

1. Create a draft post with paragraph content.
2. Ask for a follow-up edit such as:
   - add a heading after paragraph 2
   - add an image after the heading
   - change the heading from H2 to H3
3. Expect the new block or update to affect only the targeted block.

Instead, several regressions appeared in sequence. Some were planner issues, some were clarification issues, and some were execution issues. The dangerous class of failure was silent corruption: the system claimed success and wrote malformed content.

## Regression timeline

### 1. Follow-up heading-level edits overwrote surrounding blocks

Observed in earlier dry runs when a request like "change the heading from h2 to h3" caused the plan to replace a broad content slice instead of the single heading block.

Root cause:
- Planner normalized the request as a generic content rewrite instead of a single existing-block update.

Mitigation:
- `packages/services/src/generate-action-plan.ts`
- Post-processing normalization now collapses full-content heading-level edits into a single heading block replacement so nearby image and paragraph blocks are preserved.

### 2. Image follow-ups ignored attached media context

Observed when the operator attached an image and asked for a nearby edit, but the request was treated as a generic post-field change without using attachment context.

Root cause:
- Clarification analysis did not receive request attachments.
- The system could ask the wrong question or accept a plan that ignored the image attachment.

Mitigation:
- `packages/services/src/clarification-engine.ts`
- `apps/desktop/src/main/chat-service.ts`
- Attachment-aware clarification now treats a supplied image as meaningful context and asks for a reference only when the operator truly failed to mention image intent.

### 3. Clarification over-triggered on obviously specific block references

Observed when the operator said variants of:
- "the heading block"
- "the one heading H2 with New heading!"

Root cause:
- Clarification logic only trusted tightly quoted or heavily structured locators.
- Plain-language references to a unique existing heading were still flagged as ambiguous.

Mitigation:
- `packages/services/src/clarification-engine.ts`
- Existing-block clarification now accepts natural-language block locators like "the heading with New heading!" when they are specific enough.

### 4. Planner emitted malformed parsed paragraph blocks containing escaped Gutenberg comments

Observed in `dry run test 15` and again in `dry run test 16`.

Actual bad payload shape:
- A single `core/paragraph` block
- `innerHTML` contained escaped serialized Gutenberg markup such as:
  - `&lt;!-- wp:heading --&gt;New heading!&lt;!-- /wp:heading --&gt;`
- Execution inserted that malformed paragraph block after paragraph 2
- The post rendered literal Gutenberg comment text on the front end

Root cause:
- The planner or planner-adjacent normalization path sometimes produced a single malformed wrapper block containing an escaped slice of serialized post markup instead of the intended inserted block.
- Execution accepted the payload because parsed block validation treated it as ordinary HTML text.

Mitigations:
- `packages/services/src/generate-action-plan.ts`
  - Planner-side recovery already tries to decode malformed parsed blocks and recover the requested inserted blocks.
- `packages/services/src/mcp-action-map.ts`
  - Execution-side mapper now recovers the intended non-paragraph inserted block from a malformed single-block insertion payload before the MCP call is made.
  - If recovery expands to a mixed set of blocks, the mapper prefers non-paragraph blocks because the malformed wrapper commonly included surrounding paragraphs plus the true target block.
- `plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php`
  - Plugin-side write validation now rejects escaped or embedded Gutenberg block delimiters inside text-like parsed blocks such as paragraphs and headings.
  - This is the hard stop that prevents silent corruption if planner and mapper recovery both regress.

### 5. Thread/editor target drift created false negatives during debugging

Observed when the operator was viewing one draft in the editor while the execution log showed another post id was updated.

Root cause:
- Follow-up requests were correctly tied to the last touched post in the thread, but the human validation step was sometimes looking at a different draft in the editor.

Mitigation direction:
- Keep thread follow-ups sticky to the last touched post id.
- Surface the active target post id and title clearly in UI/debug state.
- Warn when the open editor target differs from the thread target.

This is partially addressed in planner context and prior-change summaries, but it remains a UI clarity concern as much as a planning concern.

## Guardrail strategy

We now intentionally protect this workflow in layers.

### Layer 1: Clarification

Purpose:
- Avoid asking unnecessary questions.
- Ask the right question when a block reference is genuinely ambiguous.

Relevant files:
- `packages/services/src/clarification-engine.ts`
- `apps/desktop/src/main/chat-service.ts`

### Layer 2: Planner normalization and block recovery

Purpose:
- Convert a user request into the smallest correct edit.
- Recover intended blocks when the raw planner output is structurally wrong but still recoverable.

Relevant file:
- `packages/services/src/generate-action-plan.ts`

### Layer 3: MCP mapper recovery

Purpose:
- Catch malformed single-block insertion payloads just before execution.
- Recover the target inserted block when planner recovery was bypassed or insufficient.

Relevant file:
- `packages/services/src/mcp-action-map.ts`

### Layer 4: Plugin write rejection

Purpose:
- Prevent malformed parsed blocks from ever being written to WordPress content.
- Fail loudly instead of claiming success with corrupted content.

Relevant file:
- `plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php`

This layer is mandatory because planner logic will continue to evolve.

## Invariants future changes must preserve

Any future work in planning, execution, or block serialization must preserve all of the following.

1. A follow-up edit request must preserve unaffected blocks.
2. A request to change a heading level must update the targeted heading block, not rewrite the whole body.
3. A placement phrase like "after paragraph 2" or "after the heading" is a locator, not the inserted block type.
4. Parsed block payloads must never contain escaped serialized Gutenberg delimiters inside text-like block HTML.
5. If malformed parsed blocks are seen during execution, the system must recover or reject them. It must never write them as-is.
6. Thread follow-ups must stay bound to the previously touched post unless the operator clearly retargets the request.
7. The system must prefer a safe failure over silent content corruption.

## Regression tests that cover this family

Planner and clarification tests:
- `tests/clarification-engine.test.ts`
- `tests/generate-action-plan.test.ts`

Execution and mapper tests:
- `tests/mcp-action-map.test.ts`

Plugin write gate tests:
- `plugins/wordpress-sitepilot/tests/WriteAbilitiesTest.php`

## Guidance for future developers

Before changing planner normalization, block serialization, or execution mapping:

1. Run the full regression tests for clarification, planner, mapper, and plugin write validation.
2. Re-test the operator workflow end to end:
   - create draft
   - add heading after paragraph 2
   - add image after heading
   - change heading H2 to H3
3. Inspect the actual MCP request payload, not just the planner summary.
4. Inspect the resulting serialized `post_content`, not just the editor preview.
5. If a change introduces a broader rewrite when a narrow block edit is possible, treat that as a regression.

## The rule to remember

If the system is about to send parsed blocks to WordPress, those blocks must already be real parsed blocks. Escaped Gutenberg comments inside `innerHTML` are not a valid fallback representation. They are a defect, and they must be recovered or rejected before execution completes.
