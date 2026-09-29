# SitePilot MCP server and Slack plan

Status: proposed on 29 September 2026. Nothing here is built yet. The design is in [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server), and the [v2 roadmap](./v2-roadmap.md#mcp-server) lists this as one item. This document turns that design into phases with exit conditions.

Scope: the SitePilot MCP server, the clients that use it (Claude Code, Claude Desktop, claude.ai connectors, Codex and the Slack app), and the hosted backend they need. The Copilot provider spike and the WordPress browser-authentication gate are prerequisites owned by other workstreams. This plan only records where they block it.

## Goals

1. Claude and Codex users can ask read-only questions about the site and start or continue change requests, from their own client.
2. Slack users can do the same from slash commands and threads, and approvers can approve from Slack.
3. Every client uses the same tools, permissions, audit trail and thread history. Slack has no private path into the engine.
4. No MCP tool can approve, execute, publish or write to WordPress directly. A person approves in SitePilot's review page or with Slack buttons.

## Where SitePilot is today (verified 29 September 2026)

- **Everything runs inside the desktop app.** The request, conversation, approval and v2 services live in `apps/desktop/src/main/`. There is no hosted backend, web app or server process.
- **The services already run without Electron.** Only `index.ts` and `ipc.ts` import `electron`. The E2E scripts (`tests/e2e/run.ts`, `tests/e2e/v2-chat.ts`) drive the services headlessly through `configureRuntimeContext` in `runtime-context.ts`. A few places still fall back to Electron at runtime, for example `getArtifactRoot()` in `gutenberg-v2-runtime-service.ts`.
- **One implicit user.** Requests, approvals and audit entries use `DEFAULT_OPERATOR` (`chat-service.ts:38`). `actorSchema` in `packages/contracts/src/common.ts` already has app roles (owner, admin, manager, approver, requester, read_only_auditor) and site roles, but nothing checks them.
- **Threads don't record a source.** `chat_threads` has `type` but no creator or client. `chat_messages.author_json` has no client field. `audit_entries.actor_json` has no client field.
- **Storage is local.** SQLite through `better-sqlite3` (`packages/repositories`). v2 journals and staged assets are files under the runtime path. Secrets use Electron `safeStorage` (`electron-secure-storage.ts`).
- **Conversations hardcode two lookups.** `conversation-service.ts` wires `sitepilot-find-posts` and `sitepilot-get-post` by hand, with their argument allowlist and prompt text. The shared lookup registry in the roadmap is not built.
- **Entry points the MCP tools will call:**
  - Requests: `ingestRequestThreadMessage` (`request-ingress-service.ts:214`), `createChatThreadForSite` and `postChatMessage` (`chat-service.ts`).
  - v2 state: `getGutenbergV2RequestState`, `getGutenbergV2ReviewArtifact` and `listGutenbergV2PendingCandidates` (`gutenberg-v2-chat-service.ts`), plus `getGutenbergV2ExecutionProgress` (`site-activity-service.ts`).
  - Conversations: `buildConversationReply` (`conversation-service.ts:900`).
  - Approval, which is never exposed as a tool: `decideGutenbergV2Candidate`, `executeGutenbergV2Candidate` and `decideApprovalForSite`.
- **LLM providers:** `packages/provider-adapters` has Anthropic and OpenAI adapters. There is no Copilot adapter.
- **No MCP server code.** `packages/mcp-client` is SitePilot's client for the WordPress plugin's MCP endpoint. `@modelcontextprotocol/sdk` is not installed.

## Approach

Build in two stages.

1. **Local first.** Run the MCP server inside the desktop app, bound to localhost. Claude Code, Claude Desktop and Codex on the same machine can then use SitePilot right away, and approval happens in the desktop app. This proves the tool surface, thread mapping and audit model against the real engine without waiting for hosting, OAuth or Copilot.
2. **Then hosted.** Move the same server package onto the hosted backend, add OAuth 2.1 and roles, then build the Slack app as a client of it. claude.ai connectors and Slack both need the hosted server.

The tool definitions, their schemas and their handlers are written once, in a package that has no Electron or transport code, so both stages share them.

## Phase 0: Decisions and gates (S, mostly not code)

Record answers in `v2-build.md` section 12 as they are made.

| Decision | Blocks | Notes |
| --- | --- | --- |
| Hosting location, database and network route to the WordPress site | Phase 5 | SQLite fits a single-instance deployment. Postgres fits if the backend needs more than one instance. |
| WordPress browser authentication for the hosted worker (V2B-01) | Phase 5 | Owned by the v2 build. The hosted worker can't compile without it. |
| Copilot provider spike | Phase 5 planning in production | Until it passes, the hosted planner can't run under the approved-LLM policy. The local stage keeps using the desktop's configured provider. |
| OAuth provider (the organisation's IdP, or a SitePilot-issued authorization server) | Phase 6 | The MCP authorization spec needs OAuth 2.1 with PKCE and protected-resource metadata. |
| How Claude and Codex users map to SitePilot users and roles | Phase 6 | Probably by IdP email or subject, onto `user_profiles`. |
| Slack workspace, app ownership and approver mapping | Phase 7 | Also decide whether requesters in Slack must also exist as SitePilot users. |
| Whether `submit_block_plan` is allowed | Phase 9 | Depends on the organisation's LLM policy. |
| Retention for review artifacts, lookup gaps and audit | Phase 5 | Also the lifetime of signed review links. |

## Phase 1: A headless core (M)

Make the services callable by something other than the desktop IPC layer, with a real actor and a client source.

### 1.1 Injected runtime (S)

- Remove the remaining Electron fallbacks from services (for example `getArtifactRoot()`). All paths, secrets and the database come from `configureRuntimeContext`.
- Add a `SecureStorage` implementation that isn't tied to Electron (environment variables or a secrets file for local and E2E runs, and the host's secret store when hosted). The interface already exists in `packages/services/src/secure-storage.ts`.
- Leave the services where they are. Moving them all into a package isn't needed yet. The MCP server can import them the way the E2E scripts do. Revisit when Phase 5 needs a separate server build.

### 1.2 Actor and source on every call (M)

- Every service entry point that the MCP server will call takes an `actor: ActorRef` and a `source` instead of using `DEFAULT_OPERATOR`. The desktop passes `DEFAULT_OPERATOR` and `source: "desktop"`, so its behaviour doesn't change.
- `source` is one of `desktop`, `hosted_app`, `slack`, `claude`, `codex` or `mcp_other`. The MCP server sets it from the OAuth client, or from the MCP `clientInfo.name` in the local stage.
- Migration:
  - `chat_threads`: add `created_by_json` and `source`.
  - `chat_messages`: record `source` in `author_json`.
  - `audit_entries`: record `source` and the MCP tool name in `actor_json` or `metadata_json`.
- The Requests and Conversations lists show where a thread started, and can filter by source.

### 1.3 Role checks in services (S)

- Add one `assertAllowed(actor, siteId, permission)` helper, with permissions `read`, `request` and `approve`.
- Call it in the entry points above. With `DEFAULT_OPERATOR` it always passes, so the desktop is unaffected. It starts to matter once Phase 6 maps real users.

**Exit:** the existing unit tests and `npm run test:e2e:content` pass unchanged, and a new unit test proves a `requester` actor can't reach `decideGutenbergV2Candidate`.

## Phase 2: Lookup registry (M–L, from the roadmap)

This is the roadmap's [lookup registry](./v2-roadmap.md#lookup-registry-and-extensible-conversations), steps 1, 2 and 4. It isn't repeated here. The MCP server only needs this much of it:

- `packages/services/src/read-tool-registry.ts`, with `find_posts`, `get_post` and `site_capabilities` as entries. Each entry has a name, a description, an input and output JSON schema, and a handler that takes `(actor, siteId, args)`.
- The desktop Conversations service builds its tools from the registry instead of from hand-written prompt text.
- Results are bounded, and marked as untrusted site content.

`query_content`, the narrow tools and lookup-gap recording can land later. Each one appears in every client as soon as it's added.

**Exit:** Conversations behaves the same on the registry, and a unit test fails if an ability that isn't marked read-only is registered.

## Phase 3: The MCP server package (M)

A new `packages/mcp-server`, built on `@modelcontextprotocol/sdk`. It defines the tools and calls the Phase 1 entry points. It doesn't open a port or read the database directly.

### 3.1 Tools

| Tool | Calls | Returns |
| --- | --- | --- |
| Registry lookups (`find_posts`, `get_post`, `site_capabilities`, and more later) | the registry handler | bounded results, marked untrusted |
| `create_conversation(site, question)` | `createChatThreadForSite` (type conversation), then `buildConversationReply` | thread ID and answer |
| `ask(thread_id, question)` | `buildConversationReply` on that thread | the answer |
| `create_request(site, text, target?)` | `createChatThreadForSite` (type request), then `ingestRequestThreadMessage` | request ID and thread ID, straight away |
| `add_to_request(request_id, text)` | `ingestRequestThreadMessage` on the request's thread | the updated state |
| `request_status(request_id)` | the v2 request state, the execution progress, and the review artifact metadata | a state, a plain-language summary, the change list and review links |
| `list_threads(site, kind?, source?, limit?)` | `listChatThreadsForSite` | recent Requests and Conversations with their source |

- `list_threads` isn't in the 9.1 table. It's needed so a client can continue a thread that another client started, which 9.1 requires. Add it to 9.1 once agreed.
- `target` in `create_request` accepts a post ID, a `find_posts` result, or `new_draft`. Free-text targets ("the last post I created") go through Phase 5 of the expansion plan once that's built. Until then the tool returns a clear refusal that asks for a post ID.
- `request_status` states map from the v2 job states to the six in 9.1: preparing preview, awaiting approval, applying, verifying, completed and needs attention. Only `completed` after read-back verification counts as success.
- Long work returns an ID at once. The server also sends MCP progress notifications when the client asks for them, and clients can always poll `request_status`.
- Review screenshots are MCP resources in the local stage, and signed, expiring URLs once hosted.

### 3.2 Guardrails

- There is no approve, execute, publish, delete or raw-write tool. A unit test lists the registered tools and fails if one appears.
- Tool annotations: lookups and `request_status` are `readOnlyHint: true`. `create_request` and `add_to_request` are `readOnlyHint: false` and `destructiveHint: false`, since they only prepare candidates.
- Tool descriptions say plainly that site content is untrusted data, and that approval happens in SitePilot.
- Every call writes an audit entry with the source, the user and the tool.
- Arguments are validated with the same zod schemas the contracts package uses.

**Exit:** unit tests for each tool against a fake runtime, including the "no write tools" test and the audit entries.

## Phase 4: Local MCP server for Claude and Codex (M)

The desktop app hosts the Phase 3 server on localhost, so the process that owns the database and the worker also serves MCP.

### 4.1 Transport and access

- Streamable HTTP on `127.0.0.1`, on a port set in Settings. It's off by default.
- A per-install bearer token, created and shown in Settings and stored in secure storage. The server rejects requests without it, and rejects `Origin` headers that aren't local, to block DNS-rebinding.
- A site selector. The token is scoped to one site, or all active sites.
- The actor is `DEFAULT_OPERATOR`, and the source comes from `clientInfo.name`. This is honest for a single-user desktop. Roles arrive with Phase 6.
- For a client that only supports stdio, add a small `sitepilot-mcp` stdio bridge that forwards to the local HTTP server. Claude Code, Claude Desktop and Codex all support HTTP servers, so this may not be needed.

### 4.2 Desktop changes

- Settings → Connections gets an "MCP server" panel: an on/off switch, the port, the token, copy-ready setup commands for Claude Code, Codex and Claude Desktop, and recent calls.
- Threads started from MCP show up in the site's Requests and Conversations lists with a source badge. Approvals show up in the Approvals page as they do now.
- `request_status` includes a `sitepilot://` deep link to the review in the desktop app.

### 4.3 Verification

- Add `npm run test:e2e:mcp`. It starts the services headlessly, connects with the SDK's client over HTTP against the MAMP site, and then:
  - answers a lookup;
  - creates a request;
  - polls it to `awaiting_approval`;
  - approves through the service call the desktop uses (not through MCP);
  - polls it to `completed`;
  - checks the audit entries and thread sources.
- Do a manual check from Claude Code and from Codex, and record the result in `v2-implementation.md`.
- Also run `npm run test:e2e:content`, since this touches `apps/desktop/src/main/` and `packages/contracts/`.

**Exit:** a request started from Claude Code, and another from Codex, both reach `completed` after approval in the desktop app, and neither client can approve.

## Phase 5: Hosted backend (L)

Blocked on the Phase 0 hosting, WordPress-authentication and Copilot decisions. This is the part of V2B-08 that the MCP server depends on.

- **Server app:** `apps/server`, a Node service that runs the same services with a server runtime context. That means a database, a secrets store, an artifact store and the Playwright worker next to it.
- **Storage:** implement the repository interfaces for the chosen database. Replace the file-based v2 journal and staged assets with database rows and object storage. Durable jobs survive restarts, as section 8 of the build spec requires.
- **Planner:** the Copilot adapter in `packages/provider-adapters`, used for every client. There's no fallback to direct OpenAI or Anthropic calls in this deployment.
- **Hosted app (web):** Requests and Conversations lists across all sources, the review page (diff, desktop and mobile previews, change list), and approve, reject and request revision. Approval uses the same backend call as the desktop, as the signed-in user.
- **Signed review links** with an expiry, for `request_status` and Slack.

**Exit:** a request made in the hosted app reaches `completed` on the target site with no desktop app or human browser session running, and the release gate in build spec section 11 passes for the hosted runtime.

## Phase 6: Remote MCP with OAuth (M)

Serve `packages/mcp-server` from `apps/server` over Streamable HTTP.

- OAuth 2.1 with PKCE, protected-resource metadata and dynamic client registration or pre-registered clients, per the MCP authorization spec, using the provider chosen in Phase 0.
- Scopes: `read` for lookups and `list_threads`, `request` for creating and revising requests, and `review` for fetching review artifacts.
- The token's subject maps to a SitePilot user and role. Unmapped users get a clear error, not a default role.
- Rate limits per user and per site.
- `source` comes from the registered OAuth client, not from anything the client says about itself.
- Connect and test from claude.ai (as a custom connector), Claude Desktop, Claude Code and Codex.

**Exit:** each Claude surface and Codex can sign in, run a lookup and start a request that a named approver approves in the hosted app. The audit shows the right client and user, and a `requester` can't fetch another user's private review.

## Phase 7: Slack app (M–L)

A Slack app built with Bolt, running beside `apps/server`. It's an MCP client of the Phase 6 server. It has no service imports and no database access, apart from its own mapping table.

### 7.1 Identity

- Map each Slack user to a SitePilot user, through the IdP (Sign in with Slack or SSO) or an admin mapping screen in the hosted app.
- The app calls MCP as that user, using per-user tokens from an OAuth flow started from Slack. It never uses one shared bot identity for everyone.
- Unmapped users get a DM explaining how to connect.

### 7.2 Commands and threads

- `/sitepilot ask <question>` → `create_conversation`. The answer posts as a thread, and replies in that thread become `ask` calls.
- `/sitepilot request <text>` → `create_request`. The bot posts a status message and starts a thread, and replies in that thread become `add_to_request` calls.
- A mapping table from Slack channel and thread timestamp to SitePilot thread ID.
- The status message updates in place as the state changes. It shows the six plain states, a short change summary and a review link. Block paths and markup diffs stay in the hosted app.

### 7.3 Approval in Slack

- When a request reaches `awaiting_approval`, the preview message gets Approve, Reject and Request changes buttons. Only mapped users with the `approver` role see them work.
- Button presses go to the backend's approval endpoint as the pressing user, not through an MCP tool. The backend checks the role and creates the approval binding, exactly as the hosted review page does.
- Approval expiry and stale-candidate rules are the same as everywhere else. An expired button says so and links to the review page.

**Exit:**

- A request made in Slack is approved in Slack and reaches `completed`.
- A request started in Claude Code can be continued from its Slack thread, or approved in the hosted app, and all three show the same thread.
- A non-approver's button press is refused and audited.

## Phase 8: Desktop on the hosted backend (M, later)

The desktop app becomes a client of the hosted backend, so its threads join the shared history. Until then, desktop threads stay local to that machine, as build spec 9.1 notes. Keep the local MCP server from Phase 4 for single-user and offline setups.

## Phase 9: `submit_block_plan` (S, only if the policy allows it)

- Off by default, and turned on per organisation.
- It accepts a strict `sitepilot.block-plan/v2` and runs it through the same compile, validation, review and approval as a planned candidate.
- The audit records that the plan came from the client's model and which client sent it.

## Order and parallel work

1. Phase 0 decisions start now. Most of them don't block the local stage.
2. Phases 1 and 2 can run in parallel.
3. Phase 3 follows Phase 1. It can start with the two existing lookups before the registry is finished.
4. Phase 4 follows Phase 3. This is the first usable milestone, for Claude Code, Claude Desktop and Codex on one machine.
5. Phase 5 can start once its Phase 0 gates pass. It doesn't depend on Phase 4, but reuses Phases 1 to 3.
6. Phase 6 follows Phase 5.
7. Phase 7 follows Phase 6.
8. Phases 8 and 9 come later.

## Testing

- Unit tests for each tool, the role helper, the "no write tools" rule and source recording.
- `npm run test:e2e:mcp` (new, Phase 4) for the MCP request loop against the MAMP site.
- Per `AGENTS.md`, Phases 1, 3 and 4 touch `apps/desktop/src/main/` and `packages/contracts/`, so each increment runs `npm run test:e2e:content`. Changes that span planning and execution, or the E2E harness itself, run `npm run test:e2e:all`.
- The hosted phases add their own gates from build spec section 11. If the WordPress E2E environment or credentials aren't available, say so in the handoff and don't mark a phase done.

## Open questions

- Should the local MCP server allow `create_request` at all, or start read-only? Recommendation: allow it, since approval still needs a person in the desktop app.
- `list_threads` needs adding to build spec 9.1. Should it also return threads started by other users, subject to role?
- Slack status updates: should the backend push to Slack through a webhook, or should the Slack app poll `request_status`? Recommendation: push, with polling as the fallback.
- Can one hosted deployment serve more than one WordPress site later, or does it stay one site per deployment, as build spec section 2 says?
