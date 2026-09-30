# SitePilot

SitePilot is a local-first desktop control plane for WordPress sites. The product combines an Electron app, shared TypeScript packages, and a thin WordPress companion plugin so operators can plan, approve, execute, and audit site changes through typed workflows instead of unrestricted admin access.

## Start Here

The current best general overview of the whole system is [docs/system-overview.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/system-overview.md).

Other high-value documents:

- [What Gutenberg v2 can do](./docs/v2-capabilities.md) for the current content engine's operations, blocks, safety rules and gaps
- [v2 implementation](./docs/v2-implementation.md) for how the v2 engine is built and verified
- [v2 roadmap](./docs/v2-roadmap.md) for planned v2 work: SEO, publishing, categories and tags, the lookup registry, the MCP server and ACF follow-ups
- [v2 build](./docs/v2-build.md) for the proposed Gutenberg content engine within the hosted, single-site Slack/Copilot build
- [v2 expansion plan](./docs/v2-expansion-plan.md) for more core blocks, ACF blocks, SEO fields, publish/unpublish and safe existing-post edits
- [docs/architecture.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/architecture.md) for the locked architectural shape and boundaries
- [SPEC.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/SPEC.md) for the full product specification
- [docs/archive/v1](./docs/archive/v1/) for the removed v1 engine: its task graph through T35, block write contract, screenshot workflow and test-runner design
- [plugins/wordpress-sitepilot/README.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/plugins/wordpress-sitepilot/README.md) for the WordPress plugin

## Repository Shape

- `apps/desktop`: Electron app with main, preload, and React renderer layers
- `packages/*`: shared domain types, schemas, repositories, services, adapters, and validation
- `plugins/wordpress-sitepilot`: thin WordPress plugin and MCP bridge
- `docs`: architecture notes, workflows, and implementation guidance
- `tests`: TypeScript unit and integration coverage

## Development

Prerequisites:

- Node.js compatible with the workspace dependencies
- npm `10.x`
- Composer for the WordPress plugin

Useful commands:

```sh
npm install
npm run typecheck
npm run lint
npm run test
npm run test:e2e:setup
npm run test:e2e:smoke
npm run test:e2e:content
npm run test:e2e:all
npm run start
```

E2E notes:

- The E2E harness requires Node `22.12+`.
- `test:e2e:smoke` registers and activates the site, then runs one request through the desktop chat.
- `test:e2e:content` adds the v2 engine suite and the local MCP server loop.
- `test:e2e:all` adds publish and unpublish, Yoast SEO, ACF blocks and a real-model long post. Scripts whose site path, second site or model key isn't configured are skipped with the reason. See `AGENTS.md`.

Plugin setup:

```sh
cd plugins/wordpress-sitepilot
composer install
```
