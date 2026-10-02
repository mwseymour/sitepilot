# Handoff: hosted SitePilot (Railway + Supabase)

Updated 2 October 2026, about 14:00 BST. Branch: `main`, all pushed and deployed: `5e8aa4a` is live on Railway, with migration 007. The user pushed the branding commit `4d07a82` as it was, including the files it swept in (`docs/v2-roadmap.md`, `plugins/wordpress-sitepilot.zip`, `.phpunit.result.cache`). The live plugin is the categories-and-tags zip, which the user uploaded on 2 October.

## Goal

Run SitePilot as a hosted service alongside the standalone desktop app, from one repo:

- The desktop app (`apps/desktop`, Electron) stays standalone on local SQLite. Don't make it depend on the server.
- The hosted server (`apps/server`) runs the same services on Supabase Postgres, deployed on Railway. It manages one WordPress site.
- People sign in with WordPress. Roles come from WordPress capabilities:
  - anyone who can publish (authors, editors, admins) approves;
  - contributors make requests.
- **The whole workflow works in chat apps** (claude.ai, Codex, Claude Code, Slack): request, see the desktop and mobile previews in the chat, then approve, apply and publish there.
- **Approval only by explicit consent the model can't fake:** a button click or the app's own prompt. Typing "approve" never approves, in chat apps or in the hosted app, where the right-hand panel buttons are still needed.
- **The hosted app looks and works like the Electron app.** The user did design work on the desktop interface. This is now done: the server serves the same React build (see below).

The user's working preferences:

- Build lean, and don't over-engineer.
- Implement the whole batch first, then test once at the end.
- Commit, then push to `main` to deploy (Railway deploys `main`).
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- "Break nothing."

## Current progress

### Architecture (all committed and pushed)

- **`packages/core` (`@sitepilot/core/<module>`)** holds the shared services: requests, chat, conversations, the v2 engine glue, the MCP backend, registration, discovery and settings. Core reads its database, secure storage and data folder only from `configureRuntimeContext` (`packages/core/src/runtime-context.ts`).
  - The desktop wires SQLite, Electron safeStorage and its user-data folder (`apps/desktop/src/main/desktop-runtime.ts`).
  - The server wires Postgres (`apps/server/src/index.ts`).
- **The app's IPC handlers are shared.** `packages/core/src/ipc-handlers.ts` exports `registerSharedIpcHandlers(host)`, with 47 of the 50 channels.
  - Electron registers them with `ipcMain` (`apps/desktop/src/main/ipc.ts`), plus the three local MCP server channels, which are desktop only.
  - The server answers them at `POST /api/ipc/:channel` (`apps/server/src/app-shell.ts`).
- **One API client for both:** `createSitePilotDesktopApi(transport)` in `packages/contracts/src/desktop-api.ts`.
  - The preload uses `ipcRenderer.invoke`.
  - In a browser, `apps/desktop/src/renderer/main.tsx` uses `fetch('/api/ipc/<channel>')` and sets `window.sitePilotHosted`.
  - `apps/desktop/src/renderer/hosted.ts` (`isHostedApp()`) hides desktop-only parts: Add site, All sites, provider keys, the local MCP server, plugin trust, supported-blocks indexing, and export and import. It adds "Account and tokens" and "Sign out" to the site menu.
  - In hosted mode the home page opens the one connected site.
- **`packages/sql` (`@sitepilot/sql`)** is one async SQL interface for SQLite and Postgres, with `@name` parameters. Shared SQL must be portable.
- **Postgres** (`packages/repositories/src/postgres.ts`) uses the `sitepilot` schema, with the API roles revoked. Migrations:
  - 001: core schema;
  - 002: encrypted secrets;
  - 003: sign-in tables;
  - 004: `stored_files`;
  - 005: OAuth;
  - 006: Slack (`slack_links`, `slack_threads`).
- **Durable files on the server:** review previews and staged media are written to the container's disk and copied to `stored_files`. They're read back from there when a deploy has wiped the disk.
  - The code is `packages/services/src/stored-file-mirror.ts`, and the optional `mirror` argument on `FileGutenbergV2ReviewArtifactStore` and `FileGutenbergV2StagedAssetStore`.
  - Core turns it on only when `sql.dialect === "postgres"`.
  - Copies older than 72 hours are deleted at startup and hourly (`pruneStoredFiles`, called from `apps/server/src/index.ts`). The user chose 72 hours on 2 October.
- **Secrets on the server** are AES-256-GCM under `SITEPILOT_SECRETS_KEY` (`packages/services/src/sql-secure-storage.ts`). Provider keys come from the `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variables.
- **REST roots:** `packages/plugin-protocol/src/rest-root.ts` builds every REST URL from the site's own REST root.

### OAuth for remote MCP (`4284b0d`, live)

- `apps/server/src/oauth.ts`: `SitePilotOAuthProvider`, behind the MCP SDK's `mcpAuthRouter`, mounted with Express for those paths only (`isOAuthPath`). Migration 005 holds clients, pending authorizations, codes, consents and tokens.
- **Flow:**
  1. `/mcp` answers 401 with `resource_metadata`.
  2. The client registers itself (open registration; https redirect URIs, or http on localhost).
  3. `/authorize` → `/oauth/consent` → Sign in with WordPress. The `sp_return` cookie brings the person back to the consent page.
  4. Allow → a one-use code → `/token`.
- **Consent page CSP:** its `form-action` includes the redirect origin, because Chrome applies `form-action` to the redirect after the post.
- **Tokens:**
  - access `spa_…`, 1 hour, bound to `/mcp`;
  - refresh `spr_…`, 30 days, rotating, with reuse ending the grant;
  - personal `spt_…` tokens still work.
- **Scopes** (in `packages/mcp-server` `TOOL_SCOPES`): `request` covers `create_request` and `add_to_request`; `review` covers `get_review_artifact`; everything else needs `read`.
- **Audit:** the client name comes from the registration (`clientDisplayName`). claude.ai is recognised by its `claude.ai` or `claude.com` callback.
- **Limits:** `/mcp` allows 120 calls a minute per person, in memory.
- **Verified live:** the discovery metadata, and 400 errors from `/token` and `/authorize` behind Railway's proxy.
- **Verified live:** the user's claude.ai (Free plan) connects with OAuth, and runs requests, the review card and publishing.

### Approving from chat apps (`0ba3b0e`, live)

The user decided: everything happens in the chat, with explicit consent, so typed text never approves.

- **`ask_to_approve`** (MCP elicitation, for Codex and Claude Code; Codex 0.145 supports it). SitePilot asks in the app's own prompt, showing what changes and the preview links. Only the answer "approve" in that prompt approves, and approving applies at once.
- **`show_review`**, claude.ai's inline card (MCP Apps, `packages/mcp-server/src/review-card.ts`). It has the previews and Approve and apply / Reject buttons.
  - The buttons call `decide_from_card`, which only the card can call (`visibility: ["app"]`), with a one-use, 30-minute ticket bound to the person and that preview, delivered in the result's `_meta`.
  - The `@modelcontextprotocol/ext-apps@1.7.5` client is inlined into the card, inside its own block because the minified bundle shares the module scope.
  - `tests/review-card-browser.test.ts` runs the card in a minimal host.
- **Publishing** is a publish request, approved the same way.
- **Core** (`createDesktopMcpBackend({ chatApproval: true })`, hosted only): `approvalSubject` and `decideForPerson`. The desktop's local MCP server has no approval tools.
- **The `approve` scope** is granted at consent only to people who can publish (`grantableScopes`). **Existing connections need reconnecting to get it.**
- **Signed preview links:** `/r/<payload>.<hmac>` (`apps/server/src/review-links.ts`), 24 hours, no sign-in, with a key derived from `SITEPILOT_SECRETS_KEY`.
- **Typed approvals** (`APPROVAL_LIKE_REPLY` in `request-ingress-service.ts`) are answered with `TYPED_APPROVAL_REPLY`, and the preview isn't rebuilt.
- **Verified live on 1 October,** by the user in claude.ai on the Free plan, after reconnecting with `approve` and starting a new chat:
  - `show_review` rendered the card;
  - the Approve button approved a publish request;
  - **post 91** ("Dynamic Search Ads and AI Max…") is published on dev.mattseymour.co.uk.
- **Also live:** the card puts its buttons first, scrolls long previews (max 420px high) and follows the apply until it's done (`289fe42`).
- **Not yet tried live:** Codex's prompt against the live server. The hosted E2E covers the prompt path locally.
- **Gotchas:**
  - claude.ai keeps a connector's tool list until a new chat.
  - Disconnecting in claude.ai doesn't revoke SitePilot's tokens; the account page lists the old grant until you disconnect it there.

### Slack (`34bfe1f`, `7730ab6`, `8480605`, live)

- **Code:** `apps/server/src/slack.ts`, inside the hosted server, without Bolt. Off until `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set in Railway (both set by the user).
- **Routes:** `/slack/events` and `/slack/interactions` check Slack's v0 signature and a 5-minute timestamp window, then answer at once. Both sit before the same-origin check in `routes.ts`. Every request is logged, with why one was refused.
- **Flow:**
  - Mention @SitePilot in a channel, or DM it. Each request lives in its Slack thread; replies revise it.
  - **Questions** (2 October, migration 008):
    - `routeSlackMessage` in `apps/server/src/slack-routing.ts` sends a question to `createConversation`, answered in the thread; replies there go to `ask`.
    - When unsure, the thread gets *Answer a question* and *Make a change* buttons (`route_ask`, `route_change`), and the message waits in `slack_threads.pending_text` (`kind = 'choosing'`).
    - `ask` or `change:` at the start forces one.
    - `slack_threads.kind` is `request`, `conversation`, `choosing` or `choosing_post`; only requests are swept. A conversation's `last_notice` holds its latest answer.
    - A conversation thread stays read-only; a change there gets "send it as a new message", suggesting the post from the last answer (the user agreed on 2 October).
  - **Which post** (`resolvePost` in `slack.ts`, helpers in `slack-routing.ts`), from the user's live test on 2 October. "Add a table below the image", after a conversation about post 102, made a new draft (post 119), and "I meant post 102" kept editing 119.
    - Now: a named post, an editor link or a link on the site's own host, "the latest post", or a new draft only for new-content wording. Otherwise the thread asks "Which post is this for?" (`choosing_post`), and the files are re-read from the thread's first message.
    - Naming another post in a request's thread asks first (`proposeMove`, with *Move to post N* / *Keep* buttons, `route_move` / `route_keep`; the reply waits in `pending_text`). Moving (`moveRequest`) starts the request again on that post with the person's messages so far, and rejects the old preview if the person can approve.
  - **The planner asks instead of guessing** (all clients, 2 October). The user's rule: when a message is unclear, clarify; never treat a badly typed message as an explicit instruction.
    - The model may return `{"clarify": "…"}`, for example "below the image" on a new draft (`GutenbergV2PlanClarification` in `gutenberg-v2-plan-generator.ts`).
    - `generateGutenbergV2Candidate` saves a clarification round, sets the request to `clarifying`, posts the question and returns `{ ok: true, clarifying }`.
    - MCP shows it as `needs_your_reply`, and Slack posts "SitePilot asks: …". The reply goes through `answerClarificationForRequest` and plans again with "Clarification: …" in the prompt.
  - **Conversations:** "post" now means post_type `post` (the agent's prompt). The plugin's `find-posts` "any" leaves out attachments (`Post_Query::content_types`; needs the next plugin zip).
  - People connect once with Sign in with WordPress: an ephemeral link to `/slack/connect?token=…`.
  - Images and MP4/WebM videos on a message go into the request (`files:read`, from `files.slack.com` only).
  - A sweeper every 8 seconds posts each open thread's changes: the change list, previews as image blocks (signed links), and Approve and apply / Reject. Notices are keyed so each is posted once.
  - Only a button click by someone who can publish approves. Typing "approved" doesn't.
  - "Done" has the post's link and a Publish it button. Publish continues the **same** request with `addToRequest("Publish it.")`, approved the same way (`8480605`; before, it started a new request).
  - When SitePilot needs attention, the thread gets SitePilot's latest message in plain words.
- **Slack app settings:** Event Subscriptions (request URL `/slack/events`), Interactivity (`/slack/interactions`), bot scopes including `files:read`. Reinstall after adding a scope.
- **Verified live** on 1–2 October in the Berkshire Devs workspace (#sitepilot-chat, free plan): connect, a request with images, review, approve, Done and Publish.
- **Gotcha:** a "signature didn't match" log means the Signing Secret in Railway is wrong; re-pasting it fixed it.

### Reusing a post's images (`8480605`, live)

- "Make that image the featured image" failed with "Unknown media ref: https://…png": the planner had no way to name an image already on the post.
- The worker's `readSource` now adds `libraryMedia` to the source snapshot (attachment ID, SHA-256 of the file, URL, alt, media type, featured), read in the editor with `wp.apiFetch` and `crypto.subtle`.
- Core offers each as a `library-<id>` media ref (`library_attachment`), and the planner prompt says never to put a URL where a media ref belongs.
- **Verified live:** Wibble (post 102) got its featured image this way.

### Library alt text (`7388582`, live: the user uploaded the zip on 2 October)

- **The report:** on Wibble (post 102), the alt text change didn't show on the front end. The body image had it (`alt` in the image block); the featured image had `alt=""`.
- **Why:** WordPress takes a featured image's alt from the media library (`_wp_attachment_image_alt`), and SitePilot uploaded images without setting it.
- **Fix:** `Media_Service` keeps the approved alt in the staged intent and sets `_wp_attachment_image_alt` on **new** image attachments (`library_alt()`). Existing attachments aren't changed, since that field is shared wherever the image is used.
- **Tests:** PHPUnit 89 passed; `npm run test:e2e:v2` passed, checking each new image's library alt via `libraryMedia` (MAMP attachments 5488–5501 have theirs).
- **Rollout:** the user uploaded the production zip on 2 October. Wibble's existing image still needs its alt set once in Media Library.
- **Decided (2 October):** follow WordPress's default. The library alt is set when an image is uploaded; later alt edits change only the image block, as in the block editor.

### Hosted server (`apps/server`)

- **Routes (`src/routes.ts`):**
  - `/` serves the React app when signed in, and the sign-in page otherwise. Sign-in returns to `/`.
  - `/assets/*` serves the renderer build (`apps/desktop/dist/renderer`, or `SITEPILOT_APP_DIR`).
  - `POST /api/ipc/:channel` (`src/app-shell.ts`):
    - needs a session (401 otherwise) and a same-origin request (403 otherwise);
    - runs as that person (`asHostedUser`);
    - refuses desktop-only channels with 404 `not_available`;
    - refuses site setup channels with 403 unless the person is an admin. Deleting a thread needs approve rights.
    - The services check approve rights for approving and applying.
    - Handler errors answer `{ ok: false, code: "internal_error" }`.
  - Kept: `/auth/*`, `/sites/connect` (only `SITEPILOT_SITE_URL`), `/account` (tokens), `/mcp` and `/healthz`.
  - `/admin/people`: the admin area (below).
  - The simple `/requests` pages were removed on 2 October. A signed-in visit to `/` on a server without the interface build answers 503, saying so.
- **The Dockerfile** builds the server and the renderer (`npm run build:renderer -w @sitepilot/desktop`), and installs headless Chromium.
- **The MCP approval hint** names the hosted app's address (the `approvalHint` option on `createDesktopMcpBackend`).

### Admin area (`b89d57e`, live)

- **`/admin/people`**, for the site's WordPress administrators (`appRole === "admin"`, from `manage_options`). It's linked from the account page and the header of the server pages. The React app doesn't know the person's role, so it has no link of its own.
- **What it lists:** everyone who has signed in (`wordpress_identities`), with their WordPress role, connected OAuth apps, personal tokens, Slack link and active app sessions.
- **Role override** (migration 007: `role_override`, `role_override_by`, `role_override_at`):
  - approver, requester, read only, or no access;
  - `toUser()` in `apps/server/src/auth.ts` applies it at every lookup (session, `spt_` token, OAuth via `userFor`, Slack via `userFor`), so it takes effect at once;
  - "no access" makes every lookup return null. `linkIdentity` returns null too, and sign-in says so;
  - WordPress administrators can't be overridden (`setRoleOverride` skips `app_role = 'admin'`);
  - signing in again refreshes the WordPress role and keeps the override.
- **Actions:** disconnect an app, revoke a token, unlink Slack, sign out everywhere (`endSessionsFor`). Each change is audited as `access_changed` (new audit event type), with the admin as the actor and the person's login.
- `oauth.connectedApps/disconnect`, `slack.linkedSlackAccounts/disconnect` and `auth.listApiTokens/revokeApiToken` take a `PersonRef` (`siteId`, `wordpressUserId`), so the admin area reuses them for other people.
- **Also changed:**
  - the account page shows the role's name and "(set by a site admin)";
  - the consent page describes the `approve` scope when it's offered, instead of saying the app can't approve.

### Chat composer fix (`b89d57e`)

After Send, `onSubmitPrompt` reloaded the bundle with its stale `loadBundle`, whose `lastRequestId` was still null. That cleared the bundle the effect had just loaded, so a new request's composer showed "New request" instead of "Change this request". Whether it broke depended on timing. `loadBundle` now takes the request ID, and the send path passes the one it just got. The hosted E2E caught it.

### Lookups: `list_terms` (`e88bd53`, live)

- **Plugin:** `sitepilot/list-terms` (`includes/Mcp/Term_Query.php`), read-only. It lists a public taxonomy's terms (category by default, or `post_tag`): ID, slug, name, parent and count, with search, parent and a limit of 1–100. Private taxonomies are refused (`invalid_taxonomy`). It's listed in `Server_Registrar`.
- **Tags:** `find-posts` and `get-post` take `tag`, and `get-post` returns `tag_slugs`.
- **Registry:** a `list_terms` entry. The Conversations agent builds its tool list from every registry entry with a `conversationPromptLine` (`CONVERSATION_TOOL_NAMES` in `conversation-service.ts`), so a new lookup needs only a plugin ability and a registry entry.
- **Rollout:** in the categories-and-tags zip (below).

### Categories and tags on posts (`c277e25`, live; not yet tried on the live site)

The roadmap's write side, first cut: **existing terms only**, posts only.

- **Contract** (`packages/contracts/src/gutenberg-v2-terms.ts`):
  - `postFields.terms` is `{category?, post_tag?}`, each the **whole set the taxonomy ends with**, as `{id, name}` sorted by ID. A post keeps at least one category.
  - Wired into `requestedPostFields` (so `requestedFieldsHash` covers it), `sourceState.affectedTermsHash` and the approval binding (`affectedTermsHash`).
  - Also: the capability snapshot's `terms.taxonomies` (the gate; older plugins leave it out), the source snapshot's `terms`, the prepared commit's `serverPreparedTermsHash`, and the readback's `terms` and `termsHash`.
- **Planner** (`gutenberg-v2-plan-generator.ts`):
  - The model writes `{"post_tag":{"add":["Lakes"]}}` (or `set` or `remove`) by name.
  - `draftWithResolvedTerms` matches names to `availableTerms`, ignoring case and punctuation, and computes the final set against `source.terms`. Unchanged taxonomies are dropped.
  - Unknown or ambiguous names go back to the model as repair issues, and fail the plan if it insists.
  - Terms are offered only on posts, with `capabilities.terms`, and when `availableTerms` was read.
- **Chat service:** `availableTermsFor` reads up to 100 categories and 100 tags with the `list_terms` lookup (`sitepilot-list-terms`) before planning. If that fails, terms aren't offered.
- **Plugin** (`includes/V2/Post_Terms.php`):
  - describe, read, hash, prepare, write and restore;
  - `Commit_Service` checks the terms at prepare (they must exist, the service user needs `assign_terms`, and InnoDB term tables are required), checks `affectedTermsHash` in both source checks, and writes with `wp_set_object_terms` after the post row in the same transaction;
  - it also records `termsHash` in `writtenState`, and restores the before-state's terms on rollback (refused if the terms changed since);
  - `Editor_Session` puts `terms` in the bridge config and the source snapshot, and `editor-bridge.js` adds it to the capability snapshot.
- **Review:** `termChanges` in the candidate summary is shown in the app's "Fields and SEO" section, in MCP `request_status` (`changes.terms`), on the claude.ai card and approval prompt, in Slack and in the chat text.
- **New terms** (2 October, after the first cut):
    - the model lists `"create": ["Mountains"]` only when the operator wants a new term. A name that exists is that term; others become `{name, new: true}`, shown in review as "Mountains (new)".
    - `Post_Terms::prepare` checks everything first, then finds or creates each new term (`get_term_by` by name, then `wp_insert_term`, needing `edit_terms`), and returns the IDs. `Commit_Service` writes `stored['termChanges']` and keeps `createdTerms` for cleanup. A retry finds the term it made, so it never duplicates one.
    - Verification compares new terms by name (`gutenbergV2TermMismatches`).
- **Not done:**
  - a site setting to turn new-term creation off, new child categories, and cleaning up unused new terms;
  - custom taxonomies;
  - sites with more than 100 categories or tags (the planner sees only the first 100);
  - showing the terms before the change in review (only the result is shown).
- **Tests:**
  - PHPUnit 98, including `PostTermsTest` with a PHP–TypeScript hash check;
  - vitest 336, including `gutenberg-v2-terms.test.ts`;
  - `npm run test:e2e:v2-terms` (new, in `all`): create with terms, tags only, stale refusal, rollback, rollback conflict, plus a real-model step with `SITEPILOT_TERMS_LLM=1`. It passed with the model step: it added the real tag and left out a made-up one;
  - the content suite (5 of 5), the SEO E2E and the hosted E2E passed.
- **Rollout:** production zip `~/Downloads/wordpress-sitepilot-terms.zip` (448 KB, 151 files, no PHPUnit; it has `list_terms`, categories and tags, and the branding). Until it's uploaded, the live editor reports no `terms` capability, so the planner doesn't offer them and `list_terms` fails as a lookup. Nothing else changes.

### Plugin (`plugins/wordpress-sitepilot`)

- Sign in with WordPress, and the editor write guard fix for `wp_global_styles` and `wp_navigation`, as before.
- **New in `2ee894f`:** `assets/js/editor-bridge.js` checks again, for up to 10 seconds, that each preview image is placed and decoded. Before, it checked once and could fail with "preview image … did not load". This was seen once in the content suite.
- **The live plugin** is the production zip of `c277e25` (`list_terms`, categories and tags, and the branding), uploaded by the user on 2 October. Its editor bridge and `Post_Terms.php` were checked on the live site.

### Deployment (live)

- **Railway:**
  - project "amused-imagination", service `sitepilot-server`, EU West;
  - deploys `main`, about 4–5 minutes a build;
  - configured in the dashboard only (`RAILWAY_DOCKERFILE_PATH=apps/server/Dockerfile`);
  - **watch paths** (Settings → Build). A push that changes nothing here is "SKIPPED":
    - `/apps/server/**`, `/packages/**`, `/package.json` and `/package-lock.json`;
    - added on 1 October because the image builds the interface: `/apps/desktop/src/renderer/**`, `/apps/desktop/index.html`, `/apps/desktop/package.json` and `/apps/desktop/vite.config.ts`.
    - The Builder field may show "Railpack (Default)" while a build runs. The build log still says "load build definition from apps/server/Dockerfile".
  - public domain `https://sitepilot-server-production.up.railway.app`. `/healthz` shows the commit, the database (4 migrations, TLS verified) and the secrets status.
  - Variables, names only: `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `SITEPILOT_PG_CA_CERT`, `SITEPILOT_SECRETS_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `SITEPILOT_SITE_URL=https://dev.mattseymour.co.uk`, `RAILWAY_DOCKERFILE_PATH`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
  - The Trial had about $4.96 left on 2 October. Idle costs about a cent or two a night.
- **Supabase:** project ref `goacdvgipyprqxjibdec`, Frankfurt, Free plan, Session pooler.
- **Live test site:** `https://dev.mattseymour.co.uk`, WordPress 7.1.2 on LiteSpeed. It's connected to the hosted server, and the user (`mattseymour`, admin) is signed in to the hosted app in their Chrome.

### Verified live on 1 October

- **In the simple pages:**
  - an edit to post 19, with a revision ("Ask for a change"), then approved and applied. WordPress shows the revised paragraph, and the post is still a draft.
  - a rejected request (nothing written);
  - a vague request, which the planner turned into a draft rather than asking a question; rejected.
- **MCP over the internet**, with a token created and revoked in the browser:
  - `list_sites`;
  - `create_request` → `request_status` → awaiting approval;
  - `get_review_artifact` returned the PNG;
  - after revoking, the next call got 401.
- **In the React app on Railway:**
  - it opens on the live site, with the full history;
  - a revision on the MCP request rebuilt its preview, then it was rejected with a reason;
  - a new request went through preview, approve and apply to **post 41, a verified draft**.
- **After deploying `86ed6ae`,** the then-pending MCP request lost its preview, before the mirror existed. The app disabled Approve and Reject ("refresh before deciding"), which is the safe behaviour.
- **Mirror check passed:** see "Persistence check" below.
- **On `edd6eb2`:**
  - Settings shows "App 0.1.0 · hosted · protocol 1.0.0".
  - MCP `request_status` gives the approval hint "Open SitePilot at https://sitepilot-server-production.up.railway.app, open the request and approve it there."
  - That request ("hint-8b14") was rejected in the app, and its token revoked (401 afterwards).
- **Nothing is left pending on the live site.** Every test request is done or rejected.
- **The user's own test, "Full complex"** (a long post with two images and SEO fields):
  - **First attempt:** it previewed and was approved, then applying failed with "Bound media attachment-1 is unavailable or exceeds the 10 MB verification limit".
  - **Cause:** the plugin installs staged media with `tempnam()` (owner-only, 0600) and `rename()`. The LiteSpeed host serves uploads as a different user, so the files answered 403 even to a browser.
  - **Fix (`066cf10`):** `Media_Service::make_readable_like_uploads()` gives the file its folder's permissions without execute bits, as WordPress does, on every bind. The worker's error now names the HTTP status.
  - **Rollout:** the user uploaded the production zip. A retry, by a reply that rebuilt the candidate, went through to **post 67, a verified draft**, with media 61 and 62 served 200.
  - **Left over:** media 52 and 53 from the failed run still answer 403. Nothing uses them; the user can delete them.

### Tests

**Policy (2 October):** the user stopped a full-suite run as far too long. Run the narrowest script that covers a change:

- `npm run test:e2e:hosted` (about 5–6 minutes) for the server, OAuth, MCP over HTTP and Slack (a stand-in Slack API);
- `npm run test:e2e:v2` (about 10 minutes) for the engine and plugin;
- `npm run test:e2e:content` (about 15 minutes) only when the engine and chat both change;
- `npm run test:e2e:all` only before a release or when asked. `tests/e2e/run-suite.ts` prints each script's time, runs `v2-acf` alongside the MAMP scripts, and skips `v2-long-post` unless `SITEPILOT_E2E_LONG_POST=1`.

Latest results (2 October, about 12:30): `npm run typecheck` clean; vitest with Postgres 329 passed, plus the new conversation test; PHPUnit 93 passed; `npm run test:e2e:hosted` passed (with the admin area steps); `npm run test:e2e:mcp` passed (with `list_terms`); `npm run test:e2e:smoke` passed (2 of 2).

**Last full pass, at `2ee894f`:**

- `npm run typecheck`: clean.
- vitest with Postgres: 310 passed. New tests:
  - `tests/server-app-shell.test.ts`;
  - `tests/stored-file-mirror-postgres.test.ts`.
- PHPUnit: 87 passed.
- `npm run test:e2e:hosted` passed. It now drives the React app:
  - sign-in lands in the app;
  - `site.register` gets 404, and a signed-out call gets 401;
  - Start request → Send → Approve this update → Apply → "Completed and verified";
  - a contributor (`sitepilot-e2e-contributor`, created on MAMP with wp-cli and a random password each run) is refused approve, execute and `site.confirmConfig`, and is shown as a requester.
- `npm run test:e2e:content`: 5 of 5 passed.
  - `v2-gutenberg` failed once with the preview image flake. It passed when rerun alone, and in the full suite after the bridge fix.
- `npm run test:e2e:all` at `edd6eb2`: 10 of 10 passed, with nothing skipped. That covers onboarding, chat, gutenberg, MCP, render check, status, SEO, ACF, long post and hosted. It left MAMP drafts 4578 (long post) and 4587 (hosted).

### Leave these alone

- `docs/v2-roadmap.md`, `plugins/wordpress-sitepilot.zip` and `.phpunit.result.cache` were committed in `4d07a82` by the branding session, and pushed with the user's OK. Ask before removing them from git.
- `plugins/wordpress-sitepilot/.phpunit.result.cache` changes on every PHPUnit run. Leave it out of commits.
- Commit the build-info files (`*.tsbuildinfo`); the user tracks them.
- Dev scripts live in `.sitepilot-test-artifacts/hosted-dev/` (git-ignored):
  - `serve.mts`: a local hosted server on fresh Postgres, connected to MAMP and signed in;
  - `shots.mts`: screenshots plus failed IPC calls;
  - `flow.mts` and `approve.mts`: drive a request;
  - `channels.mts`: checks every IPC channel is registered.

## What worked

- **Driving the user's signed-in Chrome** with `mcp__Control_Chrome__*`.
  - `open_url` with `new_tab: false` navigates the *active* tab, which may not be the one you meant. Prefer `execute_javascript` with `location.href = …` on a known `tab_id`.
  - Scripts run in an **isolated world**. The DOM is shared, but page globals (`wp`, `window.sitePilotHosted`, CodeMirror instances) aren't visible. To reach them, append a `<script>` element and write the result to a DOM attribute.
  - Async results don't come back: store them in `window.__x`, then read it in a second call.
  - React inputs need the native value setter plus an `InputEvent`. Click buttons with `dispatchEvent(new MouseEvent('click', {bubbles: true}))`.
- **Live plugin file changes without a zip:** use Plugins → Plugin File Editor.
  1. Hash the current file in the page.
  2. Apply the patch inside the page, with an injected script.
  3. Check that the result hash equals the repo file.
  4. Click Update File.
  5. Fetch the served file and hash it.
  This costs only the patch's size in tokens. A full zip passed in base64 would cost hundreds of thousands.
- **The plugin zip needs `vendor/`** (the MCP adapter, loaded by `sitepilot.php`). Build a production zip:
  1. rsync the plugin to a temp folder, without vendor, tests and `phpunit.xml`;
  2. run `composer install --no-dev --optimize-autoloader`;
  3. zip it.
  This gives about 440 KB and 149 files, with no PHPUnit. The last one is in the session scratchpad as `wordpress-sitepilot.zip`.
- **Testing hosted MCP in the browser,** so tokens never enter the transcript. Run the JS from the `/healthz` page, which has no page CSP.
- **Screenshots of the hosted app locally:** `serve.mts` and `shots.mts` (above), then read the PNGs.
- **Waiting for a deploy:** loop on `curl …/healthz` until `commit` matches.

## What didn't work

- **Docker builds locally:** Docker Hub metadata hung ("load metadata for node:22-bookworm-slim"). Railway builds the image itself, and a failed build leaves the running deployment in place.
- **Playwright clicks and waits have no timeout by default.** `getByText(...).first()` waited forever on a hidden `<pre>` with the same text. Use `.filter({ visible: true })`.
- **Named functions inside `page.evaluate`:** tsx/esbuild adds a `__name` helper that the page doesn't have (`ReferenceError: __name is not defined`). Use anonymous functions, or wrap one as `[fn][0]!`.
- **Playwright route interception** doesn't catch redirected requests. The hosted E2E uses a real local callback server for OAuth.
- **Slack's web app** won't open a tab from a synthetic click on the Connect button. The user clicks it.
- **Testing "editor = requester":** WordPress editors and authors have `publish_posts`, so they approve. Use a contributor for requester tests.
- **Top-level await in `.ts` scripts run with tsx** is compiled to CommonJS and fails. Name them `.mts`.
- Earlier ones still apply:
  - `railway.json` is ignored for new services;
  - don't complete Railway's bot check;
  - no full-screen screenshots;
  - the simple pages' CSP blocks in-page fetch;
  - stage files explicitly (`git add -u` once swept in `docs/v2-roadmap.md`);
  - no foreground `sleep` over 20 seconds.

## Persistence check (passed)

1. "AUTOMATED-TEST-HOSTED-LIVE-persist-5d2e" was created on `2ee894f` and left awaiting approval.
2. After the `edd6eb2` deploy (a new container, started 12:33 UTC), its desktop and mobile previews still loaded from Postgres, with Approve and Reject enabled.
3. It was then rejected on purpose.

## Next steps

1. **Upload `~/Downloads/wordpress-sitepilot-new-terms.zip`** (built from `07e4b4a`, after that commit is live on Railway). It adds creating new categories and tags, and makes `find-posts` "any" leave out attachments. Until then, the live plugin refuses a change that creates a term ("A requested … term doesn't exist"), and everything else works.
2. **Try in Slack:**
   - "what is the last post I created?" (a conversation);
   - "add a table below the image" (it asks which post);
   - "post 102: add a table below the image";
   - in a request's thread, "I meant post 91" (Move buttons);
   - "tag post 102 with Mountains" (shows "Mountains (new)").
3. **Note:** on 2 October the user uploaded a plugin zip a few minutes before the server deploy finished. Deploy first, then upload.
4. **Images in claude.ai** (2 October): claude.ai can't hand pasted images to MCP tools.
   - `add_images` now shows an upload card (`packages/mcp-server/src/upload-card.ts`, MCP Apps). The person drops or chooses files (images, or MP4/WebM, up to 6 at 10 MB each).
   - The card sends them with `attach_from_card`, which only the card can call, with a one-use 30-minute ticket bound to the person and the request. That goes to `addToRequest` with the attachments, and the preview is rebuilt.
   - The server instructions, `create_request` and `add_to_request` all tell Claude to use it. It needs a new chat in claude.ai.
   - The first live try (2 October), before those descriptions: Claude didn't call it, and the planner put the post's own image (media 104) in place of "this image".
   - Now `missingOperatorMediaQuestion` in the planner asks for the file before planning when a request adds an image the person is providing ("this image below…", "the attached photo", "add my logo") and no uploaded file came with it. The prompt also says a library ref never stands in for one. Checked with the real model: that request asks, and "make that image above the featured image" still reuses the post's image.
5. **Structure links:** `/r/…` links for the `structure` artifact now answer as a plain-text line diff of the block markup (`apps/server/src/structure-diff.ts`). Before, they answered 404.
6. **claude.ai:** start a new chat to pick up the updated tool guidance; claude.ai keeps a connector's tools until then. Claude decides question versus change, and which post, itself. The MCP instructions now say:
   - look the post up and use `edit` for an existing post, and `create_draft` only for new content;
   - ask when unsure;
   - a different post means a new request, not `add_to_request`;
   - pass SitePilot's `needs_your_reply` question to the person instead of answering it.
4. **Roadmap, next:**
   - categories and tags, what's left: a setting to turn new terms off, custom taxonomies, more than 100 terms, and showing the terms before the change in review;
   - target resolution from the message in the app and over MCP (Slack has it; the app still uses the Post ID field);
   - more lookups from the registry plan: `query_content`, `get_revisions`, `search_media`, `list_menus`, `find_block_usage`, and recording lookup gaps.
5. **Still open:**
   - per-site rate limits (MCP plan 6);
   - an "Add images" upload in the claude.ai card;
   - trying Codex's approval prompt against the live server;
   - the Copilot planner (the production LLM gate);
   - desktop release CI;
   - Supabase Storage for large media, if `stored_files` grows;
   - the $5 Railway usage limit after the Hobby upgrade.

## Rules to keep

- **Test content stays.** The user said on 2 October that every artifact in the test sites can stay. Don't propose cleaning up test posts, media, requests or users.

- **Never enter passwords, API keys, registration codes or tokens into web forms,** and never print them. The user enters secrets in Railway and Supabase.
  - The one exception is local test sites: the E2E sets a random password for its own test user with wp-cli.
- **Plugin updates on the live site:** the user has allowed you to update the plugin.
  - **JS and CSS:** the Plugin File Editor with a hash check works.
  - **PHP:** the editor's save failed on this host, with "An error occurred while saving your changes". WordPress checks PHP edits with a request back to the site, and reverts the file when that check fails. The user uploads a production zip instead.
  - **Don't deploy the server while the user is applying a request.** A restart cuts off the background apply.
- **Don't run E2E against the shared MAMP site while another session uses it.** Check with `ps aux | grep tests/e2e`.
- **Sync the local test sites' plugin copies before E2E:** rsync `plugins/wordpress-sitepilot/` to `/Users/mattseymour/Desktop/Test dev/wp-content/plugins/wordpress-sitepilot/` and `/Users/mattseymour/Desktop/playground/web/app/plugins/wordpress-sitepilot/`, excluding vendor, tests, composer.lock and `.phpunit.result.cache`.
- **Use Node 22:** put `$HOME/.nvm/versions/node/v22.22.3/bin` first on PATH. After running the Electron app, run `node scripts/prepare-node-sqlite.mjs` before vitest.
- **Packages load from `dist`:** rebuild with `npx tsc -b apps/desktop/tsconfig.main.json apps/server/tsconfig.json` and `npm run build:renderer -w @sitepilot/desktop` before E2E.
- **Test environment for the Postgres tests and the hosted E2E:**
  - `SITEPILOT_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55432/sitepilot_test` (`docker start sitepilot-pg-test`);
  - `SITEPILOT_E2E_WP_PATH="/Users/mattseymour/Desktop/Test dev"`.
