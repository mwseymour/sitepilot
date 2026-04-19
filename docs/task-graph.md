# SitePilot Task Graph

## Purpose

This task graph converts the spec into dependency-ordered implementation work for the first release.

Rules for execution:

- foundations run serially
- only parallelize after contracts are stable
- each task must end with code, tests, lint/typecheck status, and a short implementation note
- tasks should be PR-sized, not microscopic

## Execution Phases

### Phase 0: Architecture Lock

Lock contracts and repository structure before feature work.

### Phase 1: Platform Foundations

Create the desktop app skeleton, shared packages, persistence, and trust boundaries.

### Phase 2: Site Connectivity and Config

Build onboarding, discovery, mandatory site configuration, and activation gating.

### Phase 3: Request-to-Plan Flow

Build chat, clarification, planning, validation, approvals, and audit.

### Phase 4: Execution and Product Surfaces

Build plugin execution tools, UI screens, and operator workflows.

### Phase 5: Hardening

Add integration coverage, packaging, export/import, and failure-mode handling.

## Task Graph

| ID  | Task                                                                                                                                                      | Depends On              | Mode               | Acceptance Criteria                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| T01 | Initialize monorepo with `apps/desktop`, `packages/*`, `plugins/wordpress-sitepilot`, shared TS config, lint, formatter, test runner                      | None                    | Serial             | Workspace installs, packages resolve, base scripts run                                                                     |
| T02 | Create Electron app shell with main, preload, renderer, React bootstrapping, and packaging baseline                                                       | T01                     | Serial             | Desktop app launches, renderer loads through preload, no privileged renderer access                                        |
| T03 | Create shared domain package for core entities, enums, lifecycle states, and value objects                                                                | T01                     | Serial             | Shared types compile and are imported by app and services                                                                  |
| T04 | Define locked schema package for `SiteConfig`, `ActionPlan`, `Action`, `AuditEntry`, `DiscoverySnapshot`, `ApprovalPayload`, and protocol payloads        | T03                     | Serial             | Schemas are typed, validated, versioned, and documented                                                                    |
| T05 | Define typed IPC contract package for renderer-main interactions                                                                                          | T03, T04                | Serial             | All IPC channels are typed; no generic invoke surface                                                                      |
| T06 | Implement SQLite database bootstrap, migration runner, and repository interfaces                                                                          | T03, T04                | Serial             | DB initializes locally, migrations run deterministically, repository interfaces compile                                    |
| T07 | Implement SQLite repositories for workspace, site, config, thread, request, audit, discovery, and approval data                                           | T06                     | Serial             | Repository tests pass and no service code uses raw SQL                                                                     |
| T08 | Implement OS-backed secure storage adapter for provider keys, shared secrets, and signing keys                                                            | T02, T03                | Serial             | Secrets read/write through adapter only; tests cover missing/rotation states                                               |
| T09 | Implement logging and redaction infrastructure for app logs, tool invocations, provider telemetry, and errors                                             | T02, T03, T04           | Serial             | Structured logs exist and sensitive fields are redacted by default                                                         |
| T10 | Implement plugin protocol package for registration, signed requests, nonce/timestamp validation, versioning, and revocation semantics                     | T03, T04                | Serial             | Protocol payloads and validation helpers are stable and test-covered                                                       |
| T11 | Scaffold WordPress plugin with Composer setup, bootstrap, settings page, and protocol metadata endpoints                                                  | T10                     | Serial             | Plugin installs on WordPress and exposes version/health metadata safely                                                    |
| T12 | Embed WordPress MCP adapter and register custom SitePilot MCP server with initial read-only tools                                                         | T11                     | Serial             | Plugin exposes controlled read-only tools via MCP and passes capability checks                                             |
| T13 | Implement app-side MCP client abstraction with HTTP transport and tool schema loading                                                                     | T10, T12                | Serial             | Desktop app can discover plugin tools and read schemas from live site                                                      |
| T14 | Build site registration and trust handshake across desktop app and plugin                                                                                 | T08, T10, T11, T13      | Serial             | Site can move from unregistered to verified with persisted credentials metadata                                            |
| T15 | Build connectivity diagnostics for reachability, protocol compatibility, auth validity, capability map, and plugin version                                | T14                     | Serial             | Onboarding can show pass/fail diagnostics with actionable errors                                                           |
| T16 | Build discovery service and persistence for site metadata, post types, taxonomies, menus, fields, SEO/plugin info, and warnings                           | T13, T15                | Serial             | Discovery snapshot persists and can be refreshed deterministically                                                         |
| T17 | Build AI-generated first-pass site config draft service from discovery snapshot                                                                           | T04, T16                | Serial             | Draft config is generated into `SiteConfig` schema with required sections populated where possible                         |
| T18 | Build mandatory site config editor and activation gate so chat stays disabled until required config is confirmed                                          | T05, T07, T17           | Serial             | User can review/edit config and site only becomes chat-active when required fields are complete                            |
| T19 | Build per-site workspace shell UI with navigation for overview, chat, config, approvals, audit, and diagnostics                                           | T02, T05, T18           | Parallel after T18 | Site workspace renders from live repository data and respects activation state                                             |
| T20 | Build chat thread, message persistence, and request creation model scoped to a single site                                                                | T05, T07, T18           | Serial             | Per-site chats persist locally and can create typed requests                                                               |
| T21 | Implement context builder that assembles site config, discovery, thread history, target summaries, and prior changes                                      | T04, T07, T16, T20      | Serial             | Planner input context is reproducible and test-covered                                                                     |
| T22 | Implement clarification engine for missing material information and duplicate/similarity checks                                                           | T21                     | Serial             | Requests can transition into clarifying state with structured questions and duplicate warnings                             |
| T23 | Implement provider abstraction with OpenAI and Anthropic adapters plus usage/cost telemetry                                                               | T03, T04, T08, T09      | Serial             | Providers are interchangeable through a common interface and usage is recorded                                             |
| T24 | Implement planner that produces typed `ActionPlan` objects instead of prose                                                                               | T21, T22, T23           | Serial             | Planner outputs schema-valid plans with assumptions, actions, risks, and approval requirement                              |
| T25 | Implement policy and validation engine covering schema, capability, environment, dependency, object existence, and approval rules                         | T04, T16, T18, T24      | Serial             | Plan validation returns pass, warnings, blocked-for-clarification, blocked-for-approval, or blocked                        |
| T26 | Build approval workflow model, persistence, reviewer actions, expiry handling, and approval center UI                                                     | T07, T24, T25           | Parallel after T25 | Approval items persist, can be approved/rejected/revised, and expiry returns requests to drafted                           |
| T27 | Build immutable audit subsystem with append-only entries for request, plan, approval, execution, and rollback events                                      | T07, T24, T25           | Serial             | All major state transitions create queryable audit records                                                                 |
| T28 | Implement plugin write-side execution handlers for an initial safe action set: create draft content, update content fields, set SEO meta in allowed cases | T12, T16, T25           | Serial             | Write tools validate capability, support dry-run where feasible, and return deterministic result payloads                  |
| T29 | Implement desktop execution orchestrator with idempotency keys, dry-run previews, approval gating, and result persistence                                 | T25, T27, T28           | Serial             | Approved actions execute once, persist results, and surface clear failure states                                           |
| T30 | Build inline action preview and request status UI in chat, including diffs, warnings, and approval badges                                                 | T19, T24, T25, T29      | Parallel after T29 | User can inspect plan preview and current request state from chat                                                          |
| T31 | Build audit log UI with filtering by site, request, action, date, result, and rollback state                                                              | T19, T27                | Parallel after T27 | Operator can inspect immutable history and link back to source request                                                     |
| T32 | Build settings flows for provider keys, model selection, workspace overrides, and plugin auth management                                                  | T05, T08, T23           | Parallel after T23 | Settings work through typed IPC and never expose secrets directly to renderer                                              |
| T33 | Add rollback metadata capture and reversible-operation support for the initial action set                                                                 | T27, T28, T29           | Serial             | Reversible actions persist prior state and non-reversible actions explicitly declare compensation required                 |
| T34 | Add integration tests for onboarding, discovery, config gating, draft request planning, approval, execution, and audit persistence                        | T18, T24, T25, T27, T29 | Serial             | End-to-end flows pass in automated test environment                                                                        |
| T35 | Add packaging, compatibility metadata, export/import for configs and audit, and baseline failure-mode hardening                                           | T31, T32, T33, T34      | Serial             | Desktop build packages, plugin compatibility warnings work, exports/imports succeed, and major failure classes are covered |

## Serial vs Parallel Guidance

### Keep Serial Until T18

Do not fan out earlier than this. Before then, the team is still locking:

- core schemas
- repository structure
- IPC boundaries
- plugin protocol
- onboarding trust model
- discovery and config gating

Parallelizing before those are stable will increase rework.

### Good Parallelization Points

After T18:

- site workspace shell UI
- settings surfaces
- audit UI

After T25:

- approvals UI and workflow
- additional renderer surfaces that consume stable validated models

After T29:

- chat presentation refinements
- more audit visualization
- operator quality-of-life surfaces

### What Should Stay Centralized

These areas should have one owner at a time until mature:

- contracts/schemas
- repository interfaces
- plugin protocol
- validation engine
- execution orchestrator
- audit subsystem

## Recommended First Build Sequence

If executing strictly one task at a time, start with:

1. T01
2. T02
3. T03
4. T04
5. T05
6. T06
7. T07
8. T08
9. T10
10. T11
11. T12
12. T13
13. T14
14. T15
15. T16
16. T17
17. T18

That gets the repository, trust boundary, discovery, and config gate in place before the more expensive request and execution work starts.

## Definition of Done Template

Each task should be considered complete only when it includes:

- production-quality code
- tests for the task’s core behavior
- lint/typecheck status reported
- docs updated if contracts or architecture changed
- no unrelated refactors
- a short implementation note
- explicit assumptions and deferred items

## Immediate Next Task

Start with `T01: Initialize monorepo with Electron app, packages, shared TS config, lint, formatter, and test runner`.

That is the correct next move because the repo currently has no implementation scaffolding, and all later tasks depend on stable workspace structure.
