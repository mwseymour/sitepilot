# Agent Test Rules

When making code changes in this repository, run the smallest E2E suite that still matches the risk of the change.

## Default rule

- For ordinary code changes, run `npm run test:e2e:smoke` before finishing.

## Run `npm run test:e2e:content`

Use the content suite when changes touch content planning, execution, post updates, image handling, or WordPress write behavior, including files under:

- `apps/desktop/src/main/`
- `packages/services/`
- `packages/contracts/`
- `packages/domain/`
- `packages/provider-adapters/`
- `plugins/wordpress-sitepilot/includes/Mcp/`
- `tests/e2e/`

Especially relevant files include:

- `execution-orchestrator-service`
- `plan-generation-service`
- `chat-service`
- `image-sourcing-service`
- `mcp-action-map`
- post target resolution or lookup logic
- WordPress write abilities

## Run `npm run test:e2e:all`

Use the full suite for broader or cross-layer changes, including:

- changes spanning multiple areas above;
- refactors that affect planning plus execution;
- changes to scenario fixtures or the E2E harness itself;
- release-candidate style verification when the safest choice is to run everything.

## Test suites

- `npm run test:e2e:smoke`
  Covers basic draft creation plus a mixed Gutenberg post with an image block.
- `npm run test:e2e:content`
  Covers the smoke scenarios plus structured update flows and creating a new draft with an attached image.
- `npm run test:e2e:all`
  Covers the content suite plus the screenshot-reference scenario.

If a required suite cannot be run because the local WordPress E2E environment or credentials are unavailable, say that explicitly in the final handoff.
