# SitePilot

SitePilot is a local-first desktop control plane for WordPress sites. The product combines an Electron app, shared TypeScript packages, and a thin WordPress companion plugin so operators can plan, approve, execute, and audit site changes through typed workflows instead of unrestricted admin access.

## Start Here

The current best general overview of the whole system is [docs/system-overview.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/system-overview.md).

Other high-value documents:

- [docs/architecture.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/architecture.md) for the locked architectural shape and boundaries
- [SPEC.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/SPEC.md) for the full product specification
- [docs/task-graph.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/task-graph.md) for the implementation sequence through T35
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
npm run start
```

Plugin setup:

```sh
cd plugins/wordpress-sitepilot
composer install
```
