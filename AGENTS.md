# Agent Test Rules

When making code changes in this repository, run the smallest E2E suite that still matches the risk of the change.

## Default rule

- For ordinary code changes, run `npm run test:e2e:smoke` before finishing.
- For plugin changes, also run PHPUnit: `vendor/bin/phpunit` in `plugins/wordpress-sitepilot`.

## Run `npm run test:e2e:content`

Use the content suite when changes touch content planning, compiling, review, approval, applying, verification, media, lookups or WordPress write behavior, including files under:

- `apps/desktop/src/main/`
- `packages/services/`
- `packages/contracts/`
- `packages/domain/`
- `packages/gutenberg-worker/`
- `packages/provider-adapters/`
- `packages/mcp-server/` and `packages/mcp-client/`
- `plugins/wordpress-sitepilot/includes/`
- `plugins/wordpress-sitepilot/assets/js/editor-bridge.js`
- `tests/e2e/`

Especially relevant files include:

- `gutenberg-v2-chat-service`, `gutenberg-v2-content-service` and `gutenberg-v2-plan-generator`
- `gutenberg-v2-runtime-service`, `playwright-worker` and `wordpress-transport`
- `Commit_Service`, `Media_Service`, `Editor_Session` and `V2_Routes`
- `chat-service`, `request-ingress-service`, `conversation-service` and `mcp-backend`
- `register-site`, `Signed_Request_Verifier` and `Mcp_Permission`

## Run `npm run test:e2e:all`

Use the full suite for broader or cross-layer changes, including:

- changes spanning multiple areas above;
- refactors that affect planning plus applying;
- changes to SEO fields, publish and unpublish, or ACF blocks;
- changes to the E2E harness itself;
- release-candidate style verification when the safest choice is to run everything.

## Test suites

- `npm run test:e2e:smoke`
  Registers the site, runs discovery and activation, and checks the connection (`v2-onboarding`). Then runs a request through the desktop chat: plan, review artifacts, approve, apply and a safe re-run (`v2-chat`).
- `npm run test:e2e:content`
  The smoke suite, plus the v2 engine suite (`v2-gutenberg`): compile, approve, commit, read back and roll back, preserved blocks, new blocks and history, with signed approvals that the site requires (a missing or tampered proof is refused). Also the local MCP server loop (`v2-mcp`): lookups, a conversation, a request, approval refused from MCP and allowed from the desktop. And the render check (`v2-render-check`): a draft that doesn't render is kept and failed, and an edit that breaks a post is rolled back.
- `npm run test:e2e:all`
  The content suite, plus publish and unpublish (`v2-status`), Yoast SEO fields (`v2-seo`), ACF blocks on the ACF test site (`v2-acf`), a real-model long post with images (`v2-long-post`), and the hosted server (`hosted`): connecting the site, Sign in with WordPress in a browser, a personal MCP token, and a web request through approval to a WordPress draft.

Each script also runs on its own, for example `npm run test:e2e:v2-chat` or `npm run test:e2e:mcp`.

Some scripts in the full suite need more setup. When it's missing, the suite skips that script and prints the reason:

- `v2-status`, `v2-seo` and `v2-render-check` need the site's WordPress directory: `SITEPILOT_E2E_WP_PATH`, or `wpPath` in `.sitepilot-e2e.local.json`. With it set, every script also reads a fresh registration code with wp-cli, since each code works once.
- `v2-acf` needs the ACF site: `SITEPILOT_E2E_ACF_BASE_URL`, `SITEPILOT_E2E_ACF_ADMIN_USERNAME` and `SITEPILOT_E2E_ACF_WP_PATH` (or `_ADMIN_PASSWORD`), or `acf` in `.sitepilot-e2e.local.json`.
- `v2-long-post` needs an OpenAI key: `OPENAI_API_KEY`, or `openAiApiKey` in `.sitepilot-e2e.local.json`.
- `hosted` needs the OpenAI key, the WordPress directory, and a local Postgres: `docker start sitepilot-pg-test` and `SITEPILOT_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55432/sitepilot_test`. The same variable turns on the Postgres unit tests in vitest.

Run the suites on Node 22. The local test sites run a copy of the plugin, not the repo, so copy the plugin into the site before running WordPress E2E after plugin changes.

If a required suite cannot be run because the local WordPress E2E environment or credentials are unavailable, say that explicitly in the final handoff. Also say which scripts the suite skipped, and why.
