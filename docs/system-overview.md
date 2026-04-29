# SitePilot System Overview

## Purpose

This document is the current best-fit overview of the whole system as implemented in the repository today. Use it as the first stop before dropping into the more detailed architecture, task, or plugin documents.

## What The System Is

SitePilot is a local-first Electron desktop app for managing WordPress sites through:

- per-site chat threads
- typed request and action-plan generation
- approval-gated execution
- immutable audit history
- a thin WordPress plugin that exposes discovery and execution capabilities over MCP-compatible HTTP routes

The desktop app is the product brain. The plugin is a controlled site bridge.

## Top-Level Runtime Shape

The system is split into three runtime areas plus shared packages.

### 1. Desktop renderer

Location:

- `apps/desktop/src/renderer`

Responsibilities:

- home and site workspace screens
- chat, approvals, audit, diagnostics, config, and settings UI
- form state and user interaction
- calling a typed preload API instead of privileged APIs directly

### 2. Desktop main process

Location:

- `apps/desktop/src/main`

Responsibilities:

- typed IPC handlers
- SQLite-backed persistence bootstrap
- secure storage for provider and signing secrets
- site registration, discovery, diagnostics, and config drafting
- planner context assembly, clarification flow, and action-plan generation
- approval decisions and execution orchestration
- audit append/query flows
- export/import and compatibility metadata

This is the orchestration layer for almost all trusted behavior.

### 3. WordPress companion plugin

Location:

- `plugins/wordpress-sitepilot`

Responsibilities:

- protocol and registration routes
- MCP server registration
- read and write abilities for WordPress objects
- signed-request verification and permission checks
- WordPress-specific serialization and sanitization, including structured Gutenberg block handling

### 4. Shared TypeScript packages

Location:

- `packages/*`

Current package roles:

- `@sitepilot/domain`: core ids, entities, enums, and value objects
- `@sitepilot/contracts`: Zod schemas, protocol payloads, IPC contracts, and block support helpers
- `@sitepilot/repositories`: repository interfaces, SQLite bootstrap, migrations, and implementations
- `@sitepilot/services`: clarification, planner context, action-plan generation, MCP action mapping, and post lookup helpers
- `@sitepilot/mcp-client`: app-side MCP transport and schema handling
- `@sitepilot/plugin-protocol`: registration and protocol helpers shared with the app/plugin boundary
- `@sitepilot/provider-adapters`: provider abstraction surface
- `@sitepilot/validation`: plan and policy validation helpers
- `@sitepilot/logging`: redaction/logging support
- `@sitepilot/test-utils`: shared test support

## Main Data And Control Flow

At a high level, the implemented workflow is:

1. A site is registered from the desktop app against the plugin.
2. The app runs diagnostics and discovery, then persists a discovery snapshot.
3. The app drafts a site config and requires activation before chat workflows are live.
4. A user creates a per-site chat thread and submits a typed request.
5. Main-process services assemble planner context, run clarification checks, and generate a typed `ActionPlan`.
6. Approval logic decides whether actions can proceed.
7. Approved actions are mapped to plugin MCP tool calls and executed against WordPress.
8. Results, approvals, and rollback metadata are appended to the audit log.

## Current Desktop Surface Area

The renderer currently includes:

- home screen
- add-site flow
- global settings
- site overview
- site chat
- site config editor
- site approvals
- site audit
- site diagnostics
- site settings

The main-process service layer currently includes:

- `register-site`
- `connectivity-diagnostics`
- `discovery-service`
- `site-config-draft`
- `site-workspace-service`
- `chat-service`
- `conversation-service`
- `planner-context-service`
- `plan-generation-service`
- `approval-workflow-service`
- `execution-orchestrator-service`
- `audit-query-service`
- `settings-service`
- `planner-preferences-service`
- `planner-skills-service`
- `export-site-service`
- `import-site-service`
- `provider-status-service`
- `core-block-index-service`
- `request-visual-analysis-service`

## Persistence And Trust Boundaries

Persistent application state lives in local SQLite through repository interfaces in `packages/repositories`.

Secrets do not round-trip through the renderer. Provider keys, signing secrets, and planner preference blobs are stored through the secure-storage layer in the main process.

The renderer does not talk directly to WordPress, SQLite, or AI providers. It goes through typed IPC contracts defined in `packages/contracts` and exposed from preload.

## Current State Of The Implementation

The repository has completed the original numbered task graph through T35 in [docs/task-graph.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/task-graph.md). In practical terms, that means the repo already contains:

- the Electron shell and workspace UI
- shared contracts and domain packages
- SQLite repositories and audit querying
- secure storage and settings flows
- registration, diagnostics, discovery, and site-config activation
- chat/request persistence and planner context assembly
- screenshot-reference analysis and operator review before planning for screenshot-driven requests
- clarification and typed plan generation
- approval workflow and execution orchestration
- plugin-side MCP bridge with initial read/write capabilities
- export/import, compatibility metadata, and baseline integration coverage

## Important Known Limits

These are the main current gaps called out by the latest handoff:

- no full Electron-to-live-WordPress end-to-end CI path yet
- import is not idempotent; re-import can duplicate audit rows
- rollback metadata exists only for actions that return usable `before` state
- the numbered task graph stops at T35, so future work needs a new backlog or graph extension

## Best Documents By Need

- General current-state overview: [docs/system-overview.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/system-overview.md)
- Locked architecture and boundaries: [docs/architecture.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/architecture.md)
- Product intent and complete scope: [SPEC.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/SPEC.md)
- Build sequence and completion history: [docs/task-graph.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/task-graph.md)
- Gutenberg write contract: [docs/reliable-gutenberg-blocks.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/reliable-gutenberg-blocks.md)
- Screenshot analysis workflow: [docs/screenshot-analysis-workflow.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/screenshot-analysis-workflow.md)
- Plugin setup and routes: [plugins/wordpress-sitepilot/README.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/plugins/wordpress-sitepilot/README.md)
