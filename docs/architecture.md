# SitePilot Architecture

## Purpose

This document turns the product spec into an implementation architecture for the first local-desktop release of SitePilot.

The goal is to lock the expensive decisions early:

- module boundaries
- trust boundaries
- early contracts and schemas
- storage model
- execution pipeline
- what stays deployment-agnostic for a later hosted control plane

This is an implementation guide, not a restatement of the product brief.

## Product Shape

SitePilot is a local-first Electron desktop application that manages multiple WordPress sites through:

- per-site chat
- typed action plans
- approval-gated execution
- immutable audit history
- a thin companion WordPress plugin

The desktop app is the product brain. The plugin is a secure bridge that exposes discovery and approved execution capabilities to the app.

## Architectural Priorities

The first release should optimize for:

1. Safety over feature breadth
2. Stable contracts over fast surface-area expansion
3. Local simplicity with future cloud portability
4. Clear trust boundaries between renderer, main process, and WordPress site
5. Persistent auditability for every meaningful state transition

## High-Level Topology

The system has four primary layers.

### 1. Desktop UI Layer

Implemented in Electron renderer with React and TypeScript.

Responsibilities:

- dashboard
- site workspace
- chat UI
- approval center
- audit views
- site config editor
- settings

The renderer must not directly access:

- SQLite
- secure credentials
- WordPress network calls
- AI provider calls
- file system operations

### 2. Core Application Layer

Runs in the Electron main process.

Responsibilities:

- request ingestion
- context assembly
- clarification flow
- plan generation
- approval workflow
- validation and policy checks
- execution orchestration
- audit logging
- site discovery
- plugin communication

This layer is the heart of the product and must remain mostly deployment-agnostic.

### 3. Infrastructure Adapter Layer

Swappable adapters behind interfaces.

Responsibilities:

- repository/database adapter
- secrets storage adapter
- AI provider adapter
- MCP client transport
- notification adapter
- logging/redaction adapter
- export/import adapter

Every adapter should have a narrow interface so local Electron implementations can later be replaced in hosted mode.

### 4. WordPress Site Bridge Layer

Implemented as a thin plugin.

Responsibilities:

- registration
- request authentication
- discovery
- capability checks
- MCP tool exposure
- execution handlers
- result payloads

The plugin does not own:

- chat history
- prompts
- planning
- approvals
- multi-site coordination
- AI provider logic

## Runtime Boundaries

### Renderer

Allowed:

- presentation
- local interaction state
- form editing state
- optimistic UI state

Not allowed:

- secrets access
- raw DB access
- direct plugin calls
- provider API calls
- action execution logic

### Main Process

Owns:

- typed IPC handlers
- database connections
- secure storage
- network clients
- job orchestration
- model/provider access
- audit persistence

This split is mandatory. If the renderer starts accumulating privileged logic, the safety model collapses and hosted migration becomes harder.

## Proposed Repository Structure

Use a TypeScript monorepo from the start.

```text
/
  apps/
    desktop/
      src/
        main/
        renderer/
        preload/
  packages/
    domain/
    contracts/
    repositories/
    services/
    provider-adapters/
    mcp-client/
    plugin-protocol/
    validation/
    logging/
    test-utils/
  plugins/
    wordpress-sitepilot/
  docs/
```

### Package Intent

`packages/domain`

- domain entities
- enums
- value objects
- lifecycle states

`packages/contracts`

- IPC contracts
- action plan schema
- site config schema
- audit schema
- approval payload schema
- discovery payload schema

`packages/repositories`

- repository interfaces
- SQLite implementations
- migrations

`packages/services`

- onboarding service
- discovery service
- context builder
- clarification engine
- planner
- validator
- approval service
- executor
- audit service

`packages/provider-adapters`

- OpenAI adapter
- Anthropic adapter
- cost/usage telemetry

`packages/mcp-client`

- transport abstraction
- HTTP MCP client
- future STDIO support

`packages/plugin-protocol`

- registration/auth payloads
- signed request headers
- capability and tool schema models

`packages/validation`

- schema validation
- policy checks
- capability checks
- conflict checks

`packages/logging`

- application logging
- tool invocation logs
- redaction

## Core Domain Model

These entities should be modeled first and shared across services.

- Workspace
- UserProfile
- Site
- SiteConnection
- SiteConfig
- SiteConfigVersion
- DiscoverySnapshot
- ChatThread
- ChatMessage
- Request
- ClarificationRound
- ActionPlan
- Action
- ApprovalRequest
- ApprovalDecision
- ExecutionRun
- ToolInvocation
- AuditEntry
- RollbackRecord
- ProviderProfile
- Notification
- Attachment

### Key Relationship Rules

- Workspace has many Sites
- Site has one active config and many config versions
- Site has many discovery snapshots
- Site has many chat threads
- ChatThread has many messages and requests
- Request has zero or more clarification rounds
- Request has one current action plan
- ActionPlan has many actions
- Request may have many approval requests across revisions
- ExecutionRun belongs to one plan execution attempt
- AuditEntry attaches to site and request, and optionally to action, approval, or execution run

## Early Locked Contracts

These contracts must be settled before broad implementation. They are the highest-cost rewrite points.

### 1. SiteConfig Schema

Must cover:

- identity and business context
- structure
- content model
- field model
- SEO policy
- media policy
- approval policy
- tool access policy
- content style policy
- guardrails

Rules:

- versioned
- auditable
- explicit required fields for chat activation
- serializable without Electron-specific assumptions

### 2. ActionPlan Schema

The planner must output a typed object, not prose.

Minimum shape:

- request summary
- assumptions
- open questions
- target entities
- proposed actions
- dependencies
- risk classification
- approval requirement
- rollback notes
- validation warnings

### 3. Action Schema

Every executable action must have:

- stable type identifier
- version
- input schema
- validation rules
- permission requirement
- risk classification
- dry-run support flag
- rollback support metadata

### 4. AuditEntry Schema

Audit must persist:

- request text
- clarifications and answers
- plan versions
- model/provider version metadata
- tool invocations
- validation results
- approvals
- execution timestamps
- result payloads
- rollback state

Audit is not optional logging. It is a product-level data model.

### 5. Plugin Trust Contract

Must define:

- site UUID
- workspace UUID
- trusted app identifier/origin
- protocol version
- credential status
- signing material reference/fingerprint
- nonce and timestamp rules
- request ID format
- rotation and revocation semantics

### 6. IPC Contract

Must define typed request/response surfaces between renderer and main for:

- site onboarding
- config editing
- chat actions
- approvals
- audit queries
- settings and provider configuration

No untyped “invoke anything” IPC channel should exist.

### 7. Discovery Snapshot Schema

Must normalize:

- site metadata
- post types
- taxonomies
- menus
- fields
- templates
- capability summaries
- SEO integration info
- warnings and known limitations

### 8. Approval Payload Schema

Must carry:

- request summary
- linked thread and site
- proposed actions
- object-level diffs
- affected URLs
- risk score
- execution dependencies
- rollback notes
- reasoning summary

## Data Storage Strategy

### Primary Persistence

SQLite is the default local persistence layer.

Reasons:

- embedded and simple for desktop distribution
- no external database dependency
- sufficient for first-release local workflows
- easy to abstract behind repository interfaces

### Secrets

Secrets must not be stored as plaintext in SQLite.

Use OS-backed secure storage for:

- AI provider keys
- site shared secrets
- app signing private keys
- refresh tokens

SQLite stores references, metadata, and rotation timestamps only.

### Repository Rule

All database access must go through repository interfaces. No raw SQL should appear in:

- renderer code
- orchestration services
- validation services

Direct SQL is allowed only inside repository implementations and migration files.

## Execution Pipeline

The request pipeline in the main process should be:

1. Ingest user message
2. Load site config and recent thread context
3. Load discovery snapshot and relevant object summaries
4. Classify request type
5. Run clarification analysis
6. Ask follow-up questions or continue
7. Generate typed action plan
8. Validate plan against schema, site policy, environment, and capabilities
9. Present preview and approval requirement
10. Await approval if required
11. Execute actions through plugin tools
12. Persist execution results and audit entries
13. Summarize outcome back to the thread

This pipeline should be represented in code as services, even if multiple steps share a single model call initially.

## Validation Model

Every action must pass:

- schema validation
- site policy validation
- capability validation
- object existence checks
- dependency validation
- environment validation
- approval rule checks
- conflict detection

Validation outcomes:

- pass
- pass with warnings
- blocked pending clarification
- blocked pending approval
- blocked permanently

## Approval Model

Approval is mandatory when:

- a change publishes immediately
- a live page changes materially
- navigation changes
- a slug changes
- redirects change
- key SEO metadata changes
- multiple objects are affected
- risk is high or critical
- site policy mandates review

This logic belongs in policy/validation services, not ad hoc UI conditionals.

## Audit Model

Audit must be treated as immutable operational history.

Practical rule:

- create append-only audit entries for state transitions and execution artifacts
- avoid destructive mutation of historical records
- if later normalization is needed, do it through linked records rather than overwriting meaning

Rollback support should capture previous values where feasible, but lack of rollback support must itself be auditable.

## Plugin Architecture

The WordPress plugin should include these internal modules:

- bootstrap
- registration/settings
- auth verifier
- request signer/verifier
- discovery service
- action registry
- validators
- execution handlers
- MCP server registration
- audit callback hooks
- compatibility checks

The plugin should embed the official WordPress MCP adapter via Composer and expose a custom SitePilot MCP server for controlled tool exposure.

## Transport Strategy

### Default

HTTP MCP transport for live sites.

### Secondary

STDIO transport for local development and diagnostics when WP-CLI access is available.

The desktop app should own its own MCP client runtime rather than relying on an external proxy.

## Security Model

Non-negotiable rules:

- signed requests only
- explicit allowlists
- no public unauthenticated write endpoints
- approval on high-impact actions
- secrets isolated from the renderer
- no unrestricted shell or code execution
- no theme/plugin editing by default
- no raw SQL or arbitrary settings writes

Environment labels matter:

- production
- staging
- development

Policy can differ by environment, but the environment must be explicit in the site model and validation flow.

## Local-First, Cloud-Portable Rules

The following must remain deployment-agnostic:

- domain entities
- request lifecycle
- site config model
- action schemas
- approval semantics
- audit model
- MCP client abstraction
- provider abstraction
- repository interfaces

What can change later for hosted mode:

- renderer becomes web app
- SQLite becomes hosted relational DB
- secrets move server-side
- background execution becomes queue-backed
- auth becomes hosted identity

What must not change:

- plugin protocol
- site registration model
- action contract shapes
- approval semantics
- audit semantics

## Recommended First Vertical Slice

The first end-to-end slice should prove the architecture with minimal surface area:

1. Add a site
2. Register and verify the plugin
3. Run discovery
4. Generate and persist a draft site config
5. Enforce mandatory config completion before chat activation
6. Create a simple draft content request
7. Generate a typed plan with one low-risk content action
8. Persist audit and execution artifacts

This is the correct first proof because it exercises:

- renderer/main IPC
- persistence
- secrets
- plugin trust
- discovery
- site config gating
- planning
- validation
- audit

without requiring the full product surface.

## Decisions Deferred On Purpose

These should be kept open until design spikes or early implementation clarifies them:

- whether plugin diagnostics use MCP only or MCP plus a thin signed REST surface
- how much full content is cached locally beyond summaries and metadata
- how generic ACF support is in the first release
- how local sign-in/profile protection works
- which component library is best for dense desktop UI

These are real decisions, but they do not block the repository and contract foundations.
