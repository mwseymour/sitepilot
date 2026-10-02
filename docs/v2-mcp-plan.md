# SitePilot MCP server and Slack plan

Status: the local stage (Phases 1 to 4) was implemented on 29 September 2026, with Phase 2 in part. A first hosted slice (parts of Phases 5 and 6) followed on 30 September and 1 October; see [Delivered on 1 October 2026](#delivered-on-1-october-2026). Phases 7 to 9 are proposed. The design is in [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server), and the [v2 roadmap](./v2-roadmap.md#mcp-server) lists this as one item. This document turns that design into phases with exit conditions.

Scope: the SitePilot MCP server, the clients that use it (Claude Code, Claude Desktop, claude.ai connectors, Codex and the Slack app), and the hosted backend they need. The Copilot provider spike and the WordPress browser-authentication gate are prerequisites owned by other workstreams. This plan only records where they block it.

## Delivered on 29 September 2026

- **Phase 1:** a call context (`apps/desktop/src/main/call-context.ts`) carries the actor and the client source through every service call, using `AsyncLocalStorage` rather than new parameters. Desktop calls default to the desktop operator with `source: "desktop"`, so the desktop behaves as before.
  - `ActorRef` gained an optional `source`, so request, message, approval and audit actors all record the client with no extra columns.
  - Migration `007_chat_thread_source` adds `chat_threads.source`, which the activity summary returns.
  - Approving, rejecting and applying (`decideGutenbergV2Candidate` and `executeGutenbergV2Candidate`; v1's `decideApprovalForSite` was removed on 30 September 2026) refuse any caller without the approve role. Asking for a revision is still allowed, since it's part of the request conversation.
  - Not done: removing the remaining Electron fallbacks, and a non-Electron `SecureStorage` outside the E2E one. The local stage didn't need them.
- **Phase 2 (in part):** `packages/services/src/read-tool-registry.ts` defines `find_posts`, `get_post` and `site_capabilities`. The Conversations service takes its prompt lines and argument sanitizing from it.
  - Not done: building tools from the plugin's ability schemas, the plugin-side read-only check, `query_content`, the narrow tools and lookup gaps.
- **Phase 3:** `packages/mcp-server` has the tools, the backend interface, the localhost HTTP host and the client-source mapping, built on `@modelcontextprotocol/sdk` 1.31. Differences from the plan:
  - A request ID is the request's thread ID, so follow-ups that start a new request in the same thread keep the same ID.
  - Two more states: `needs_your_reply`, when SitePilot asks a clarifying question, and `rejected`.
  - `list_sites` and `get_review_artifact` were added. Review screenshots come back as MCP image content from a tool rather than as resources, because more clients support that.
  - There are no progress notifications. Clients poll `request_status`.
  - `create_request` refuses free-text targets. It takes `create_draft`, or `edit`, `replace`, `publish` or `unpublish` with a `post_id`.
- **Phase 4:** the desktop app runs the server from Settings → MCP server. It's off by default, listens on 127.0.0.1 (port 8765 by default) and needs a bearer token. The panel shows copy-ready setup for Claude Code, Codex and Claude Desktop (through `mcp-remote`).
  - Local clients act as the desktop operator with only the `request` site role, so they can look things up and prepare requests, but they can't approve.
  - The source comes from `clientInfo.name`: `claude-*` becomes `claude`, `codex-*` becomes `codex`, and anything else is `mcp_other`.
  - `npm run test:e2e:mcp` (`tests/e2e/v2-mcp.ts`) passes against the MAMP site. It connects as Codex over HTTP and covers a lookup, a Conversation, a request reaching `awaiting_approval`, a PNG review screenshot, the approval being refused from the MCP context and allowed from the desktop's, `completed` with the post ID, `list_threads` by source, and the audit entries. Unit tests are in `tests/mcp-server.test.ts` and `tests/call-context.test.ts`.
  - Not done: a source badge in the desktop thread lists (the data is there), a `sitepilot://` deep link to the review, and the stdio bridge. Claude Code and Codex connect over HTTP; Claude Desktop uses `mcp-remote`.
  - Not yet checked by hand from real Claude Code and Codex sessions.

## Delivered on 1 October 2026

The hosted server runs on Railway (`apps/server`) with Supabase Postgres. It runs the same services as the desktop, which now live in `packages/core`. The desktop app stays standalone on SQLite.

- **Phase 5 (in part):**
  - Postgres storage behind the same repositories as SQLite (`@sitepilot/sql`), in a `sitepilot` schema the Supabase REST API doesn't expose. Migrations run at startup under an advisory lock.
  - Encrypted secrets: site secrets, approval keys and provider keys, AES-256-GCM under `SITEPILOT_SECRETS_KEY`.
  - Connecting a site with its registration code (`/sites/connect`). One site per deployment.
  - The app is the desktop interface, served by the server. The same React build runs in Electron and in the browser. In the browser it calls the same IPC handlers (`packages/core/src/ipc-handlers.ts`) over `POST /api/ipc/:channel`. Each call needs a signed-in session from the same origin, and runs as that person.
    - Desktop-only calls are refused, and hidden in the interface: adding sites, provider keys, the local MCP server, export and import.
    - Site setup calls need the admin role. Approving and applying need a WordPress role that can publish, as on the desktop.
  - Sign-in, connecting the site, the account page (tokens) and the admin area are server-rendered. The simple request pages that were at `/requests` were removed on 2 October 2026, since the app replaces them. A server built without the interface says so at `/`.
  - The Playwright worker runs in the same container, with headless Chromium in the image. The planner key comes from `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; the Copilot adapter is still the gate for production.
  - Review files and staged media are written to the container's disk and copied to Postgres (`stored_files`, migration 004), so a deploy doesn't lose the previews of requests waiting for approval. Copies older than 72 hours are deleted at startup and hourly.
  - Not done: Supabase Storage for large media, signed review links, and a separate worker service.
- **Phase 6 (in part):**
  - Sign in with WordPress (6.1): the plugin's confirm page and signed, two-minute, one-use assertion, returned only to the callback the client registered. Roles come from WordPress capabilities at every sign-in.
  - Remote MCP at `/mcp` with a personal token from the account page (`claude mcp add --transport http …`). Each session acts as the token's owner.
  - OAuth 2.1 for remote MCP clients such as claude.ai and Claude Desktop (`apps/server/src/oauth.ts`, migration 005). It follows the MCP authorization spec:
    - discovery: `/mcp` answers 401 with `resource_metadata`, then `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`;
    - open dynamic client registration, with https redirect URIs or http on localhost;
    - PKCE (S256), and codes that work once and last 10 minutes;
    - access tokens last 1 hour; refresh tokens last 30 days, rotate on each use, and end the whole grant if a used one comes back;
    - tokens are bound to `/mcp` (RFC 8707);
    - revocation.
  - The MCP SDK's router serves those endpoints. The SitePilot provider sends `/authorize` through Sign in with WordPress and a consent page, remembered per app until its scopes change or it's disconnected.
  - Scopes: `read` (lookups, threads, conversations, status), `request` (`create_request`, `add_to_request`) and `review` (`get_review_artifact`). They narrow what a connection can do on top of the person's WordPress role.
  - The audit's `source` comes from the registered client (claude.ai is known by its callback), not the MCP handshake. The account page lists connected apps with Disconnect. `/mcp` allows 120 calls a minute per person.
  - Roles follow WordPress capabilities: anyone who can publish (authors, editors, admins) approves; contributors request. The hosted E2E checks that a contributor is refused approving, applying and site setup.
  - Approving from chat apps, on the hosted server (decided 1 October 2026). Only the person's own answer approves, in a channel the model can't write to:
    - `ask_to_approve` asks the person in the app's own prompt (MCP elicitation): Codex, Claude Code. SitePilot shows what changes, with links to the previews.
    - `show_review` shows claude.ai's inline review card (MCP Apps), with the desktop and mobile previews and Approve and apply / Reject buttons. The buttons call `decide_from_card`, which only the card can call, with a one-use ticket. The ticket is for that preview and that person, and lasts 30 minutes.
    - Approving applies at once. Publishing and unpublishing are their own requests, approved the same way.
    - It needs the `approve` OAuth scope, which the consent page offers only to people who can publish. The decision is audited with its channel (`approval_prompt` or `review_card`) and signed with the site's approval key as before.
    - A chat message such as "approved" never approves: in the hosted app, on the desktop and over MCP, it gets a pointer to the Approve button and the preview isn't rebuilt.
    - Preview links are signed and open without signing in, for 24 hours (`/r/<token>`). They're in `request_status`, in the approval prompt and in `get_review_artifact`.
  - The admin area, at `/admin/people`, for the site's WordPress administrators (2 October 2026). It lists everyone who has signed in, with their WordPress role, connected apps, personal tokens, Slack link and app sessions.
    - **Role override** (migration 007): approver, requester, read only, or no access, set per person. It wins over the WordPress role at every lookup (sessions, tokens, OAuth and Slack), so it applies at once. "No access" turns everything off, signing in included. WordPress administrators can't be overridden.
    - **Disconnect an app, revoke a token, unlink Slack, or sign someone out everywhere.**
    - Each change is recorded in the site's audit log as `access_changed`, with the admin as the actor.
  - Not done: per-site rate limits.
- **Phase 7 (in part), the Slack app** (`apps/server/src/slack.ts`, migration 006), running inside the hosted server rather than as a separate service:
  - **Starting a request:** mention @SitePilot in a channel, or DM it. Each request lives in its Slack thread, and replies in the thread revise it or answer SitePilot's questions. Images and MP4/WebM videos on a message go into the request (`files:read`, from Slack's file host only).
  - **Asking a question** (2 October 2026, migration 008):
    - A question about the site ("what is the last post I created?") is answered in its thread as a read-only Conversation, and replies there ask again.
    - SitePilot decides from the wording (`apps/server/src/slack-routing.ts`). When it can't tell, it asks in the thread with *Answer a question* and *Make a change* buttons, or a typed reply of *ask* or *change*.
    - Starting a message with `ask` or `change:` forces one.
    - A conversation thread stays read-only: a change asked for there gets "send it as a new message", with the post from the last answer suggested ("post 102: …"). In a request's thread, `ask …` gets an answer without touching the request.
  - **Which post a change is for** (Phase 5 for Slack, 2 October 2026):
    - a post named in the message ("post 102", an editor link, or a link to the post on the site);
    - "the latest post";
    - a new draft only when the message asks for new content ("write a post about…", "a new page");
    - otherwise SitePilot asks "Which post is this for?" and waits. It never guesses a new draft for "add a table below the image".
    - "On it" names the post before anything is planned.
    - Naming another post in a request's thread ("sorry, I meant post 102") moves the request there, with the request so far, and rejects the earlier preview so it can't be applied by mistake.
    - Not done: the `/sitepilot` slash command, which needs the command added in the Slack app settings.
  - **Connecting:** people connect once with Sign in with WordPress. The link goes only to them (ephemeral in channels), and the connect page names the Slack account and the WordPress user it will act as.
  - **Reviewing:** the thread gets the change list, the desktop and mobile previews as image blocks (signed links), and Approve and apply / Reject. A click, signed by Slack with the clicking user, is the approval; only people who can publish can approve. Typing "approved" doesn't approve.
  - **Finishing:** "Done" comes with the post's link and a Publish it button, which continues the same request as a publish, approved the same way.
  - **Mechanics:** `/slack/events` and `/slack/interactions` check Slack's signature and timestamp and answer at once. A sweeper posts each open thread's changes and survives restarts. It's off until `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set.
  - Tested live in the Berkshire Devs workspace (#sitepilot-chat) on 1–2 October 2026, and in the hosted E2E against a stand-in Slack API.
- **Tests:** `npm run test:e2e:hosted` runs the server on a disposable local Postgres against the MAMP site. It covers:
  - connecting the site;
  - signing in through a real browser;
  - the app's API refusing desktop-only and signed-out calls;
  - a token and MCP lookups;
  - an OAuth connection, as claude.ai makes one: discovery, registration, sign-in and consent in a browser, a scoped token (a lookup works, `create_request` is refused), one-use codes, remembered consent, refresh, and Disconnect;
  - Slack, against a stand-in Slack API: connecting, a request with its review, a typed "approved" doing nothing, Approve, Publish it, and Approve again, to a published post;
  - a request in the app through review, approval and apply, to a draft in WordPress.

## Goals

**Chat users** are people who use SitePilot only through a chat client, such as Slack, and never open the desktop or hosted app.

1. Claude and Codex users can ask read-only questions about the site and start or continue change requests, from their own client.
2. **Chat users can run the whole workflow from Slack without opening any SitePilot app (requirement):**
   - ask questions;
   - make and revise requests;
   - see the preview;
   - approve or reject;
   - have the change applied;
   - publish and unpublish;
   - see the result, or why it failed.
3. Every client uses the same tools, permissions, audit trail and thread history. Slack has no private path into the engine.
4. No MCP tool can approve, execute, publish or write to WordPress directly. A person approves, either with Slack buttons or in SitePilot's review page. Approval never comes from a model calling a tool.

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
  - Approval, which is never exposed as a tool: `decideGutenbergV2Candidate` and `executeGutenbergV2Candidate`. (v1's `decideApprovalForSite` was removed on 30 September 2026.)
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
| Hosting location, database and network route to the WordPress site | Phase 5 | **Hosting and database decided on 30 September 2026:** the services and the hosted web app run on Railway, and the data sits separately in Supabase (Postgres and Storage). See build spec section 12. The network route is still open. A fixed outgoing IP isn't needed by default, because every call to the plugin is signed. It's only needed if the site limits `wp-admin` to listed IPs or its firewall blocks cloud traffic. Testing runs on Railway's Hobby plan without one. If a client needs one at launch, move to Pro (see build spec section 12). |
| WordPress browser authentication for the hosted worker (V2B-01) | Phase 5 | Owned by the v2 build. The hosted worker can't compile without it. |
| Copilot provider spike | Phase 5 planning in production | Until it passes, the hosted planner can't run under the approved-LLM policy. The local stage keeps using the desktop's configured provider. |
| OAuth provider (the organisation's IdP, or a SitePilot-issued authorization server) | Phase 6 | **Decided on 30 September 2026:** `apps/server` issues its own OAuth 2.1 tokens, and its login step is Sign in with WordPress through the plugin. No SSO or external IdP. See [6.1](#61-sign-in-with-wordpress). |
| How Claude and Codex users map to SitePilot users and roles | Phase 6 | **Decided on 30 September 2026:** by the WordPress user they sign in as, linked by ID onto `user_profiles`. |
| Slack workspace, app ownership and approver mapping | Phase 7 | **Approver mapping decided on 30 September 2026:** Slack users link by signing in with WordPress, and get their role from WordPress like everyone else. Requesters must link too. Still open: which workspace, and who owns the app. |
| How roles are assigned to chat users | Phase 7 | **Decided on 30 September 2026:** from WordPress capabilities. People who can publish on the site can approve, and other users can request. The hosted app's admin area can override a role. |
| Whether Approve also applies | Phase 5 | The desktop approves and applies in two clicks. For chat users, the recommendation is that Approve applies at once, and publishing stays a separate approved step. |
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

- **Server app:** `apps/server`, a Node service on Railway that runs the same services with a server runtime context. The Playwright worker and the Slack app run as separate Railway services beside it, and secrets live in Railway.
- **Storage:** implement the repository interfaces for Postgres on Supabase. Only the backend connects to it. Replace the file-based v2 journal and staged assets with database rows and Supabase Storage, and serve review artifacts through signed links. Durable jobs survive restarts, as section 8 of the build spec requires.
- **Planner:** the Copilot adapter in `packages/provider-adapters`, used for every client. There's no fallback to direct OpenAI or Anthropic calls in this deployment.
- **Hosted app (web):** served by `apps/server` on Railway, on the same domain as the API. Requests and Conversations lists across all sources, the review page (diff, desktop and mobile previews, change list), and approve, reject and request revision. Approval uses the same backend call as the desktop, as the signed-in user.
- **Signed review links** with an expiry, for `request_status` and Slack.
- **Apply without an operator.** Once a request is approved, the backend applies it as a durable job on the hosted worker. Chat users never need an app open for that, and nor does anyone else.

**Exit:** a request made in the hosted app reaches `completed` on the target site with no desktop app or human browser session running, and the release gate in build spec section 11 passes for the hosted runtime.

## Phase 6: Remote MCP with OAuth (M)

Serve `packages/mcp-server` from `apps/server` over Streamable HTTP.

- OAuth 2.1 with PKCE, protected-resource metadata and dynamic client registration or pre-registered clients, per the MCP authorization spec. `apps/server` is the authorization server, built on the MCP SDK's server auth helpers. Its login step is Sign in with WordPress (6.1).
- Scopes: `read` for lookups and `list_threads`, `request` for creating and revising requests, and `review` for fetching review artifacts.
- The token's subject is the linked WordPress user, and their role comes from WordPress (6.1). Unmapped users get a clear error, not a default role.
- Rate limits per user and per site.
- `source` comes from the registered OAuth client, not from anything the client says about itself.
- Connect and test from claude.ai (as a custom connector), Claude Desktop, Claude Code and Codex.

### 6.1 Sign in with WordPress

Decided on 30 September 2026. There's no SSO or external identity provider. The site's own WordPress login proves who someone is, so it inherits any 2FA or SSO the site already has.

1. The person starts from the hosted app's login, the Slack app's Connect button, or the OAuth login page that Claude or Codex opens.
2. `apps/server` sends them to a SitePilot connect page on their WordPress site, with a one-use `state`. They log in to WordPress as usual.
3. The plugin sends back a signed, one-use, short-lived confirmation of the WordPress user: their ID, email and capabilities. It's signed with the key the site already shares with SitePilot, and it only goes to the `apps/server` callback registered for that site.
4. `apps/server` links that WordPress user to the Slack, Claude or Codex identity by ID (Slack workspace and user ID, or OAuth client and token), never by email. A matching email only pre-fills the link. Email alone isn't enough, because of Slack Connect and guest accounts, emails a WordPress admin sets without the owner confirming, and reused addresses. It also isn't enough for requesters, since lookups return drafts and private posts.
5. Roles come from WordPress capabilities. People who can publish on the site can approve, and other users can request.

The hosted app's admin area lists each person with their WordPress user, linked Slack, Claude and Codex accounts, and role. An admin can override a role, unlink an account and revoke tokens. The site's WordPress administrators are the admins, and they prove it with the same login.

**Exit:** each Claude surface and Codex can sign in, run a lookup and start a request that a named approver approves in the hosted app. The audit shows the right client and user, and a `requester` can't fetch another user's private review.

## Phase 7: Slack app (M–L)

A Slack app built with Bolt, running beside `apps/server`. It's an MCP client of the Phase 6 server. It has no service imports and no database access, apart from its own mapping table.

### 7.1 Identity

- Each Slack user links once: a Connect button sends them to sign in with WordPress ([6.1](#61-sign-in-with-wordpress)). A matching email only pre-fills the link. Admins can see and undo links in the hosted app's admin area.
- The app calls MCP as that user, using per-user tokens from an OAuth flow started from Slack. It never uses one shared bot identity for everyone.
- Unmapped users get a DM explaining how to connect.

### 7.2 Threads and commands

**One top-level Slack message is one SitePilot thread. Replies in its Slack thread are follow-ups on it.** A DM with SitePilot is a list of threads, like a chat list in Claude or ChatGPT, not one long conversation.

```
DM with SitePilot
├─ "Write a post about our spring pricing"    → Request A
│    ├─ [status card: Preview ready · Approve / Reject / Request changes]
│    ├─ you: "make the intro shorter"          → add_to_request on A
│    └─ SitePilot: new preview
├─ "Unpublish the old pricing page"           → Request B
│    └─ [status card: Awaiting approval]
└─ "Which posts mention the summer sale?"     → Conversation C
     └─ SitePilot: answer; replies here are ask calls
```

- **Starting a thread.**
  - A top-level DM message, or a message that mentions `@SitePilot` in a channel, starts a new thread under that message.
  - SitePilot decides from the wording whether it's a Request or a Conversation, the same way the desktop does.
  - `/sitepilot request <text>` and `/sitepilot ask <question>` force one or the other.
- **Replies.** A reply in a Request's Slack thread becomes `add_to_request`, and a reply in a Conversation's becomes `ask`.
- **Status card.**
  - Each Request has one status card, the bot's first reply in the thread. The bot edits it in place (`chat.update`) as the state changes: preparing, needs your reply, awaiting approval, applying, completed, or needs attention.
  - The card shows a short change summary, the target post, and the approval buttons from 7.3.
  - Questions, new previews and results are posted as replies under it.
  - Block paths and markup diffs stay in the hosted app.
- **Several requests at once.**
  - Requests run side by side, each in its own thread, and each card updates on its own.
  - Buttons act only on their own thread's request, so approving one request can never touch another.
- **Mapping table.** A table maps each Slack channel and top-level message timestamp to a SitePilot thread ID and back. `list_threads` and the hosted app show the same threads, labelled with the source `slack`.
- **Follow-ups sent at the top level.** Someone may send "now publish it" as a new message instead of replying in the thread.
  - It starts a new thread, and SitePilot works out what "it" means from that person's recent requests, as the desktop already does within a thread.
  - The target is always named on the preview card before approval, for example "Publish: Spring pricing (post 1777)", so a wrong guess is caught before anything changes.
  - When more than one recent request fits, the bot asks, with a button for each.
- **Channels.** A `@SitePilot` thread in a channel works the same way, and anyone in the channel can see it. Buttons still check the pressing user's role.
- **Home tab.** The app's Home tab is the chat user's overview:
  - Waiting for your approval (approvers only);
  - My open requests;
  - Recently done.

  Each entry links to its thread.

### 7.3 The whole workflow in Slack

Everything a chat user needs happens in the Slack thread. The review page is an optional extra, never a required step.

- **Review in the thread.**
  - The preview message shows the desktop and mobile screenshots as images, plus the change list: title, excerpt, SEO fields and featured image.
  - Blocks that will be removed or preserved are listed in plain words.
  - The structure diff stays in the hosted app for anyone who wants it.
- **Decide in the thread.**
  - Approve, Reject and Request changes buttons appear when a request reaches `awaiting_approval`.
  - Request changes opens a short Slack form, and its text becomes an `add_to_request` revision.
- **Apply.**
  - Approve applies the change straight away, subject to the Phase 0 decision. The thread then shows applying, verifying, and completed with the post and its edit link.
  - A failed check or a rollback is reported in plain language.
- **Publish and unpublish.**
  - "publish it" or `/sitepilot publish <post>` prepares a publish step, which gets its own Approve button.
  - The result says whether the public URL loaded.
- **Expiry and staleness.**
  - An expired approval, or a post that changed since review, gets a fresh preview and new buttons in the thread. It doesn't send the user to an app.
- **Who can press what.**
  - Only mapped users with the approver role can approve, reject or publish. Anyone mapped as a requester can request changes.
  - Button presses go to the backend's approval endpoint as the pressing user, not through an MCP tool. The backend checks the role and creates the approval binding, exactly as the hosted review page does.

**Exit:**

- A chat user takes a request from `/sitepilot request` to a verified, published post, without anyone opening the desktop or hosted app.
- A request started in Claude Code can be continued from its Slack thread, or approved in the hosted app, and every client shows the same thread.
- A non-approver's button press is refused and audited.
- An expired or stale approval can be redone entirely in Slack.

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

- Should Claude and Codex users also be able to approve without an app? MCP elicitation could show an approval form inside the client, but only some clients show it to the user directly, so it can't be the only route. Until this is decided, they approve in Slack or the hosted app.

- Should the local MCP server allow `create_request` at all, or start read-only? Recommendation: allow it, since approval still needs a person in the desktop app.
- `list_threads` needs adding to build spec 9.1. Should it also return threads started by other users, subject to role?
- Slack status updates: should the backend push to Slack through a webhook, or should the Slack app poll `request_status`? Recommendation: push, with polling as the fallback.
- Can one hosted deployment serve more than one WordPress site later, or does it stay one site per deployment, as build spec section 2 says?
