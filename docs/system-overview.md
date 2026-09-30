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
4. A user creates a per-site request thread, chooses what to change (a new draft, or a post by ID) and describes the change.
5. The Gutenberg v2 engine plans the blocks and builds a candidate in the site's own block editor, with review previews.
6. A person approves the candidate. The approval is bound to that exact result.
7. The plugin commits the approved markup through its signed v2 routes, and a fresh editor session reads it back to verify it.
8. Requests, approvals and results are appended to the audit log.

v2 is the only content engine; the older v1 action-plan engine was removed on 30 September 2026. See [What Gutenberg v2 can do](./v2-capabilities.md).

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
- `chat-service` and `request-ingress-service`
- `conversation-service` and `external-page-research-service`
- `gutenberg-v2-chat-service`, `gutenberg-v2-runtime-service` and `gutenberg-v2-report`
- `request-bundle-service`
- `site-activity-service`
- `acf-block-test-service` and `third-party-block-test-service`
- `mcp-server-service` and `mcp-backend` (the local MCP server)
- `audit-query-service`
- `settings-service`
- `planner-preferences-service`
- `export-site-service`
- `import-site-service`
- `provider-status-service`
- `core-block-index-service`

## Persistence And Trust Boundaries

Persistent application state lives in local SQLite through repository interfaces in `packages/repositories`.

Secrets do not round-trip through the renderer. Provider keys, signing secrets, and planner preference blobs are stored through the secure-storage layer in the main process.

The renderer does not talk directly to WordPress, SQLite, or AI providers. It goes through typed IPC contracts defined in `packages/contracts` and exposed from preload.

## Current State Of The Implementation

The repository completed the original numbered task graph through T35 ([archived with v1](./archive/v1/task-graph.md)), and then built the Gutenberg v2 engine. In practical terms, the repo contains:

- the Electron shell and workspace UI
- shared contracts and domain packages
- SQLite repositories and audit querying
- secure storage and settings flows
- registration, diagnostics, discovery, and site-config activation
- chat/request persistence and Conversations (read-only lookups and page research)
- the Gutenberg v2 engine: planning, editor-built candidates, review artifacts, bound approvals, signed commits, read-back verification and conditional rollback
- a local MCP server for Claude Code, Codex and Claude Desktop
- a plugin-side MCP bridge with read-only lookups
- export/import, compatibility metadata, and baseline integration coverage

## Important Known Limits

These are the main current gaps called out by the latest handoff:

- no full Electron-to-live-WordPress end-to-end CI path yet
- import is not idempotent; re-import can duplicate audit rows
- see the [v2 roadmap](./v2-roadmap.md) and [hardening plan](./v2-hardening-plan.md) for planned work

## Best Documents By Need

- General current-state overview: [docs/system-overview.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/system-overview.md)
- Locked architecture and boundaries: [docs/architecture.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/architecture.md)
- Product intent and complete scope: [SPEC.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/SPEC.md)
- Build sequence and completion history (v1, archived): [docs/archive/v1/task-graph.md](./archive/v1/task-graph.md)
- Gutenberg v2 capabilities: [docs/v2-capabilities.md](./v2-capabilities.md)
- The removed v1 engine's docs: [docs/archive/v1](./archive/v1/)
- Plugin setup and routes: [plugins/wordpress-sitepilot/README.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/plugins/wordpress-sitepilot/README.md)
