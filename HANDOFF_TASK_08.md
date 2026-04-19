# HANDOFF_TASK_08

## 1. Current Status

### Task 7 completion status

Task `T07` is complete.

What `T07` completed:

- Implemented concrete SQLite repository interfaces in [packages/repositories/src/interfaces.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/interfaces.ts)
- Implemented deterministic SQLite bootstrap and migrations in:
  - [packages/repositories/src/sqlite.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite.ts)
  - [packages/repositories/src/migrations.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/migrations.ts)
- Implemented concrete SQLite repositories in [packages/repositories/src/sqlite-repositories.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite-repositories.ts)
- Wired repository registry creation into `initializeDatabase(...)`
- Added bootstrap and round-trip tests in:
  - [tests/sqlite-bootstrap.test.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/tests/sqlite-bootstrap.test.ts)
  - [tests/sqlite-repositories.test.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/tests/sqlite-repositories.test.ts)

### Acceptance criteria status

`T07` acceptance criteria passed:

- Repository tests pass
- Raw SQL is confined to repository/bootstrap code under `packages/repositories`
- No app/service/orchestration code outside the repository package is using raw SQL

### Verification status

All checks were passing at handoff time:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run format`
- `npm run build -w @sitepilot/desktop`

### Git branch

- Current branch: `main`

### Key files changed in Task 7

- [packages/repositories/src/interfaces.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/interfaces.ts)
- [packages/repositories/src/migrations.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/migrations.ts)
- [packages/repositories/src/sqlite.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite.ts)
- [packages/repositories/src/sqlite-repositories.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite-repositories.ts)
- [packages/repositories/src/index.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/index.ts)
- [tests/sqlite-bootstrap.test.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/tests/sqlite-bootstrap.test.ts)
- [tests/sqlite-repositories.test.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/tests/sqlite-repositories.test.ts)

## 2. Architecture Decisions Now Locked

These decisions are already locked by `T01` through `T07` and should not be changed during `T08`.

### Decisions Cursor must not change

- The app is an Electron desktop app with a strict renderer/main privilege boundary.
- The renderer must not access secrets, SQLite, WordPress network calls, or provider keys directly.
- Shared domain types live in `packages/domain`.
- Runtime-validated cross-boundary schemas live in `packages/contracts`.
- SQLite is the default local persistence layer.
- DB access goes through repository abstractions in `packages/repositories`.
- Typed IPC is already the renderer/main boundary contract; no generic “invoke anything” IPC channel should be introduced.

### Relevant contracts/interfaces

#### Domain model

Important domain types already exist in:

- [packages/domain/src/entities.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/entities.ts)
- [packages/domain/src/enums.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/enums.ts)
- [packages/domain/src/ids.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/ids.ts)
- [packages/domain/src/value-objects.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/value-objects.ts)

Secret-related future consumers already exist in the domain model, especially:

- `SiteConnection`
- `ProviderProfile`

#### Contracts/schemas

Locked runtime schemas already exist in:

- [packages/contracts/src/schemas.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/schemas.ts)
- [packages/contracts/src/protocol.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/ipc.ts)
- [packages/contracts/src/common.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/common.ts)

Relevant schema areas:

- `siteConnectionSchema`
- `siteRegistrationSchema`
- `signedRequestHeadersSchema`
- `workspaceListResponseSchema`
- IPC request/response schemas in `ipc.ts`

### DB schema / migration changes already in place

SQLite schema is locked for now by migration `001_initial_core_schema` in:

- [packages/repositories/src/migrations.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/migrations.ts)

Relevant tables for Task 8:

- `site_connections`
  This stores non-secret metadata such as status, protocol version, plugin version, trusted origin, and credential fingerprint.
- `provider_profiles`
  This stores provider profile metadata such as kind, label, base URL, and model defaults.

Important rule:

- Secrets are not stored in plaintext in SQLite.
- If Task 8 needs DB interaction at all, it should store references, fingerprints, aliases, or metadata only.
- Do not add plaintext secret columns to existing tables.

### IPC contracts

Current typed IPC contracts live in:

- [packages/contracts/src/ipc.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/ipc.ts)
- [apps/desktop/src/main/ipc.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/apps/desktop/src/main/ipc.ts)
- [apps/desktop/src/preload/index.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/apps/desktop/src/preload/index.ts)

Current channels:

- `app.getShellInfo`
- `workspace.list`
- `site.list`
- `settings.getProviderStatus`

Task 8 may add secure-storage-related IPC only if absolutely needed, but:

- it must be typed in `packages/contracts/src/ipc.ts`
- it must be validated on both main and preload sides
- secrets must still never be exposed directly to the renderer unless the contract is intentionally designed for masked/non-sensitive output

### Plugin/app auth contracts

Relevant auth/trust schemas already exist in:

- [packages/contracts/src/protocol.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/protocol.ts)

Locked auth model details:

- `siteRegistrationSchema`
- `registrationCredentialSchema`
- `signedRequestHeadersSchema`
- `protocolHealthSchema`

Do not change:

- signed request header field names
- registration payload shape
- the idea that the app holds sensitive signing material while the plugin stores public/fingerprint data

Task 8 should support future storage of:

- provider API keys
- site shared secrets
- signing private keys
- refresh tokens

without redefining the auth contract itself.

### MCP tool/schema decisions

MCP transport/tooling is not implemented yet, but the architecture is already decided in docs and should remain unchanged:

- the WordPress plugin will embed the official WordPress MCP adapter
- SitePilot will expose a custom MCP server/tool surface rather than broad default public write access
- the desktop app will own its own client runtime

Do not use Task 8 to redesign MCP packaging or runtime boundaries.

### Audit trail decisions

Audit is append-oriented and mandatory.

Relevant existing pieces:

- `AuditEntry` in [packages/domain/src/entities.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/entities.ts)
- `auditEntrySchema` in [packages/contracts/src/schemas.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/schemas.ts)
- `audit_entries` table in [packages/repositories/src/migrations.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/migrations.ts)
- `SqliteAuditEntryRepository` in [packages/repositories/src/sqlite-repositories.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite-repositories.ts)

Task 8 should preserve this principle:

- secret operations should be auditable later by event metadata
- secret values themselves should not be written into audit payloads

## 3. Known Issues / Caveats

### Anything unfinished

- `T08` has not started.
- There is no secrets adapter yet.
- No secrets-specific IPC exists yet.
- No provider key persistence exists yet beyond schema/domain placeholders.
- No site shared secret or signing key persistence exists yet.

### Intentionally deferred tech debt

- No decision has been implemented yet between Electron `safeStorage`, `keytar`, or a hybrid secure-storage approach.
- No cross-platform packaging validation has been done for secrets storage.
- No logging/redaction layer exists yet; that is `T09`.
- No repository exists for `SiteConnection` or `ProviderProfile` yet; `T07` intentionally stopped at workspace/site/config/thread/request/discovery/approval/audit coverage.

### Assumptions made so far

- SQLite stores only non-sensitive metadata and references.
- Secret material will live outside SQLite.
- Main process is the only acceptable place to perform secret reads/writes.
- The renderer should consume masked status only, not raw secret values.

### Risks for Task 8

- Native dependency choice matters:
  `keytar` is common but introduces native module build and packaging concerns.
- Electron `safeStorage` encrypts/decrypts strings but still requires a persistence location; using it cleanly needs a clear file-format/location decision.
- A hybrid adapter may be best:
  OS-backed secure store when available, with explicit error handling when unavailable.
- Task 8 must not accidentally create an IPC path that leaks secrets into renderer state.
- Task 8 must not weaken the future auth model by storing private keys or shared secrets in SQLite.

## 4. Exact Task 8 Brief

### Goal

Implement an OS-backed secure storage adapter for:

- provider API keys
- site shared secrets
- signing private keys
- refresh tokens

The adapter must live on the privileged side of the app and provide a stable interface for later tasks such as provider configuration, site registration/auth, and request signing.

### Scope

In scope:

- define a secrets storage interface
- implement a desktop/main-process secure storage adapter
- support read, write, delete, exists/lookup operations
- support storing provider credentials, site secrets, and signing-key material by typed key namespace
- support rotation-friendly semantics
- add tests covering:
  - store/retrieve
  - missing secret lookup
  - overwrite/rotation behavior
  - delete behavior
- add only the minimum wiring needed for use from privileged code

### Out of scope

- do not implement provider adapters
- do not implement site registration flow
- do not implement plugin signing
- do not implement settings UI for secrets entry
- do not add renderer-facing raw secret IPC
- do not redesign repository or contract layers
- do not add logging/redaction work beyond what is strictly necessary for tests or internal errors

### Files or modules likely involved

Most likely places:

- [packages/services/src](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/services/src)
  Good candidate for a `secure-storage.ts` interface plus adapter abstraction.
- [apps/desktop/src/main](/Users/mattseymour/Desktop/ai-dev/sitepilot/apps/desktop/src/main)
  Good candidate for desktop-specific implementation wiring if Electron APIs are required.
- [packages/domain/src/entities.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/entities.ts)
  Only if a small supporting type is genuinely needed.
- [packages/contracts/src/ipc.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/ipc.ts)
  Only if a typed non-sensitive status IPC surface is required.
- [tests](/Users/mattseymour/Desktop/ai-dev/sitepilot/tests)
  Add secure storage tests here.

Likely avoid touching:

- `packages/repositories` schema/migrations unless absolutely necessary
- existing task docs except for small status updates if wanted

### Dependencies on prior tasks

Task 8 depends on:

- `T02` for the Electron privileged runtime split
- `T03` for domain modeling

It should respect:

- `T04` locked contracts
- `T05` typed IPC boundary
- `T06`/`T07` rule that secrets are not stored in SQLite

### Acceptance criteria

Task 8 is complete when:

- secrets read/write through a dedicated adapter only
- adapter runs on the privileged side, not renderer
- missing secret lookups are handled and tested
- rotation/overwrite behavior is handled and tested
- delete behavior is handled and tested
- no plaintext secrets are added to SQLite schema or repositories
- no raw secret values are exposed to the renderer

### Validation steps

Run:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run format`
- `npm run build -w @sitepilot/desktop`

If Task 8 adds Electron-main-specific wiring, also verify the desktop build still succeeds.

### Definition of done

- production-quality code
- tests for store/read/missing/delete/rotation flows
- no unrelated refactors
- docs updated only if an architectural choice is locked
- explicit note in code or docs about which secure-storage backend was chosen and why

## 5. Cursor Instructions

### Where to start reading

Read in this order:

1. [docs/task-graph.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/task-graph.md)
   Focus on `T08`.
2. [docs/architecture.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/architecture.md)
   Focus on runtime boundaries, secrets, and infrastructure adapter sections.
3. [packages/domain/src/entities.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/entities.ts)
   Look at `SiteConnection` and `ProviderProfile`.
4. [packages/contracts/src/ipc.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/ipc.ts)
   Understand the typed IPC pattern before adding anything.
5. [apps/desktop/src/main/ipc.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/apps/desktop/src/main/ipc.ts)
   Follow the current main-process handler pattern.
6. [packages/repositories/src/sqlite.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite.ts)
   Confirm that DB state currently excludes secrets.

### What to verify first

Before coding:

- verify whether the secure storage implementation will use Electron `safeStorage`, `keytar`, or a composed adapter
- verify that the chosen backend can be exercised in tests without making the suite brittle
- verify that no current table or repository expects plaintext secrets in SQLite

### What not to refactor

Do not refactor:

- `packages/repositories/src/migrations.ts`
- `packages/repositories/src/sqlite-repositories.ts`
- `packages/contracts/src/schemas.ts`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/ipc.ts`
- Electron shell/window config in `apps/desktop/src/main/index.ts` and `window-config.ts`

Task 8 should be additive, not a cleanup pass.

### TODO preservation

There are no meaningful in-code TODO chains to preserve right now.

Preserve the current shape of:

- typed IPC
- repository boundaries
- audit append pattern
- contract exports

### Whether a git checkpoint should be created first

Yes. Create a git checkpoint before starting `T08`.

Reason:

- `T01` through `T07` are in a clean, verified state
- `T08` introduces a new subsystem boundary and likely a native/platform-specific dependency choice

Recommended checkpoint label:

- commit current state before starting secure storage work

## 6. Suggested First Command Or First Action For Cursor

First action:

- open and read [docs/architecture.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/architecture.md), [docs/task-graph.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/task-graph.md), [packages/contracts/src/ipc.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/contracts/src/ipc.ts), [packages/domain/src/entities.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/domain/src/entities.ts), and [packages/repositories/src/sqlite.ts](/Users/mattseymour/Desktop/ai-dev/sitepilot/packages/repositories/src/sqlite.ts) before writing code.

Suggested first command:

```sh
git status --short && sed -n '1,260p' docs/architecture.md && sed -n '1,220p' docs/task-graph.md
```

After that, make the secure storage backend choice explicitly and implement `T08` without changing existing persistence or IPC architecture unnecessarily.
