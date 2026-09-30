# SitePilot hardening plan

Status: proposed on 29 September 2026. Nothing here is implemented yet. Work starts on 30 September 2026.

Source: a read-only review of the WPVibe plugin (`vibe-ai` 1.19.2, SeedProd), followed by research into how SitePilot handles the same concerns today. This plan covers:

- removing the v1 content engine;
- the trust gaps that research turned up;
- five ideas taken from the WPVibe review.

We are reimplementing the ideas, not copying WPVibe's code. WPVibe is GPL-2.0-or-later, so if any of its code is ever copied, keep its copyright notices.

## Goals

1. **v2 is the only content engine.** v1 plan execution and the plugin's v1 write abilities are removed.
2. **No trust gaps.** Every gap in [Fix first](#fix-first-trust-gaps) is closed and has a regression test.
3. **Retry-safe writes.** A lost response never causes a second post, attachment or block insertion.
4. **One error format.** The plugin, the desktop, SitePilot's MCP server and the planner all use the same error shape. Each error has a stable code, a cause, a retry flag and, for auth failures, the reason the request was refused.
5. **Safe URL fetching.** No URL taken from a user, a model, a page or a third-party API can reach loopback, private, link-local or metadata addresses, directly or through a redirect. File types are decided from the bytes, not from headers.
6. **Render check after apply.** SitePilot notices when a change breaks the rendered page, for example an ACF block template that throws. It rolls back the change on an existing post, and marks a new draft failed with the reason.
7. **Approvals the site can verify.** The plugin refuses a write unless it carries a signed approval. Holding the site's connection secret isn't enough to make one up.

## Fix first: trust gaps

These were found on 29 September 2026 while researching the ideas below. Each one has an ID so the phases, tests and handoffs can refer to it.

| ID | Gap | Where | Fixed in |
| --- | --- | --- | --- |
| T1 | **The registration code never changes.** `/sitepilot/v1/register` is open to anyone (`__return_true`). The code is never rotated or consumed, despite the "one-time" wording. The client chooses the `siteId`, and `save_site` overwrites an existing one. Anyone who once saw the code can register their own client at any time, or replace the desktop's secret and lock it out. | `Rest/Registration_Routes.php:26-36`, `Registration/Store.php:20-45` | Phase 2.1 |
| T2 | **Signed calls skip capability checks.** `trusted_or_can_*` return true for any registered signed site, whatever the mapped user may do. The v2 routes are not affected: they set the mapped user and check `edit_post`, `create_posts`, `publish_posts` and `upload_files`. | `Mcp/Write_Abilities.php:355-381` | Phase 1, which deletes the v1 write abilities. Phase 2.2 adds a regression test. |
| T3 | **MCP falls back to the first administrator.** When a registered site has no mapped user, signed MCP calls run as the first administrator, or failing that the first user with `read`. | `Mcp/Mcp_Permission.php:57-95` | Phase 2.1 |
| T4 | **A pasted link can read local services.** Page research follows redirects to any address, `http` included, and returns the page text. The MCP `ask` tool reaches the same path. So the MAMP admin, localhost dev servers, the cloud metadata address and LAN admin pages are all reachable. Image search validation only checks the first URL and follows redirects unchecked. The v1 image download has no checks at all. | `external-page-research-service.ts:107-125`, `image-sourcing-service.ts:186-213`, `execution-orchestrator-service.ts:665-752` | Phase 3 for page research. Image search and the v1 download are deleted in Phase 1. |
| T5 | **Subscribers can list draft titles.** Every read ability needs only `read`, and `find-posts` accepts `post_status: any`. So any logged-in subscriber, including one using an application password, can list draft and pending titles. | `Mcp/Abilities_Registrar.php:67-277`, `Mcp/Post_Query.php:44-51` | Phase 2.2 |
| T6 | **The nonce check can race.** It is a check-then-set on a transient, so parallel replays can both pass. An object cache can also evict the transient before the 300-second window ends. | `Security/Signed_Request_Verifier.php:135-139` | Phase 2.2 |
| T7 | **v1 changes images after approval.** It runs the image search again at apply time, so the uploaded image can differ from the one that was reviewed. | `execution-orchestrator-service.ts:794, 1223` | Phase 1. Phase 1 also confirms v2 never picks images at apply time. |
| T8 | **Any logged-in user reaches the plugin MCP route.** `check_access` lets any logged-in user with `read` through before the signature check, and application passwords count as logged in. Local Claude and Codex clients already go through the desktop's own MCP server, so nothing needs this path. | `Mcp/Mcp_Permission.php:30-55` | Phase 2.2 |

## Where SitePilot is today (verified 29 September 2026)

| Area | Exists | Missing |
| --- | --- | --- |
| Retry safety, v2 | `executionId` plus `idempotencyKey` keys the prepared commit, the receipt and media progress. `/commit` returns the stored receipt on replay. The desktop always calls `/reconcile` before `/commit` (`packages/services/src/gutenberg-v2-content-service.ts:886`, `Commit_Service.php:308`). Lost-response reconciliation is verified in `v2-implementation.md:169`. | Permanent 409s such as `stale_source` from `/commit` are marked retryable, so a job can sit in `committing` indefinitely. Signed writes have no HTTP timeouts. |
| Retry safety, v1 | A local key reuses completed runs (`execution-orchestrator-service.ts:72-83`). | The write abilities take no key, and a failed run calls the tool again, so a lost response creates duplicates. **Goes away in Phase 1.** |
| Errors | v2 has a typed code enum (`packages/contracts/src/gutenberg-v2.ts:1686`), and the worker and service error classes carry `retryable`. | See the gaps below. |
| URL fetching | The v2 worker and preview resolver check origins, block redirects, cap sizes and sniff bytes. v2 staged media sniffs magic bytes (`packages/services/src/gutenberg-v2-media.ts:56`). | T4. The v1 download and v1 `upload-media-asset` trust declared types and have no size caps; both go in Phase 1. |
| Render check | Fresh-editor readback checks the block structure. Publish checks the public URL for a 2xx but discards the body (`wordpress-transport.ts:173-198`). `/recover` rolls back an existing post if nobody has changed it since the write. `Acf_Blocks::render_failure` renders a block and catches errors, but only for fixture diagnostics. | Nothing renders the post after a content apply, checks its status or looks for a PHP fatal. |
| Approval integrity | The desktop builds an approval binding over the candidate, content, fields, source hashes and media manifest. `prepare` recomputes the hashes and compares them field by field (`Commit_Service.php:647-689`). | The approval is unsigned JSON, so anything holding the site's connection secret can make one up. `approverId` is stored but never checked. The expiry is chosen by the desktop, with no cap, and an `approvalId` can be reused. |

**Error-format gaps:**
- The plugin has three error styles.
- The desktop has nearly 100 ad hoc codes.
- Two plugin-response parsers disagree on 401 and 403.
- Unknown codes become retryable `editor_unavailable`. That includes `rollback_failed`, which should never be retried blindly.
- Auth failures collapse to a bool in PHP.
- The MCP server returns text-only errors (`packages/mcp-server/src/server.ts:107`).

## Approach

1. **Remove v1 first.** It removes T2, T7 and half of T4 outright, and shrinks every later phase.
2. **Fix trust and fetching alongside it.** T1, T3, T4, T5, T6 and T8 are live security issues and touch different files from the v1 removal.
3. **Then build the error format.** The retry and render-check phases need its codes.
4. **Then retry safety and the render check, in parallel.**
5. **Then signed approvals.** They depend on the registration fixes in Phase 2, and they also prepare for the hosted backend, where approval and applying happen in different places (Phase 5 of the [MCP plan](./v2-mcp-plan.md#phase-5-hosted-backend-l)).

## Phase 0: Decisions

### Decided on 29 September 2026

| Decision | Outcome |
| --- | --- |
| v1 | **Remove v1 now**, rather than hardening or freezing it. See [Phase 1](#phase-1-remove-v1-l). |
| What the render check does for a new draft | **Keep the draft and mark the job failed with the reason.** Don't delete it. That matches the draft-retention rule in `v2-build.md:207`. |
| Approval proofs | **Build them now**, as part of this work, rather than waiting for the hosted backend. See [Phase 7](#phase-7-signed-approval-proofs-m). |
| Whether page research may fetch `http://` | **Yes, for public addresses only**, after the IP checks in Phase 3. |
| The v1 features lost with v1 ([1.1](#11-what-goes-with-v1)) | **Accept losing them.** Port two later as v2 roadmap items: images by URL or stock search (through Phase 3's `safeFetch`), and finding the target post from the message (already v2 roadmap Phase 5). |
| What `SITEPILOT_V2_ENABLED=false` means once v1 is gone | **A write kill-switch.** With it off, the site is read-only to SitePilot. |
| Compatibility across plugin versions | **Add a `features` list to `/protocol`**, for example `error_contract_v1`, `render_check_v1` and `approval_proof_v1`. Sites update the plugin separately from the desktop, so the desktop uses a feature only when the site advertises it, and keeps parsing the old error shapes. |

## Phase 1: Remove v1 (L)

Mapped on 29 September 2026.

**Where v1 is still reachable:**
- **In the app,** only through the Dry-run and Execute buttons in the Developer panel (`DeveloperPanel.tsx:68-90`). They show on old v1 plans when developer tools are on.
- **At ingress,** v1 planning runs only when a caller leaves out `gutenbergV2Target` (`request-ingress-service.ts:145-160`). The renderer and `mcp-backend.ts` always pass one, so in practice only tests reach it.
- **In Conversations,** "turn this into a request" (`chat-service.ts:365`) creates a request with no engine. That request then gets v1 clarification and a "Next: generate a plan" message.

**The E2E suites in `AGENTS.md` test v1 only.** `test:e2e:smoke`, `test:e2e:content` and `test:e2e:all` run `tests/e2e/run.ts`, which plans with the v1 planner, approves with `decideApprovalForSite` and executes with `executePlanAction`. They are also the only E2E tests that run the real register, discovery and activation flow. The v2 scripts set the site active directly. **So the v2 suites have to be wired in before `run.ts` is deleted.**

### 1.1 What goes with v1

Accepted on 29 September 2026 (Phase 0).

- Automatic featured and inline images from Wikimedia or Unsplash search, and images from a URL. v2 uses attached files and existing media-library items only.
- Authoring `core/html`, `core/shortcode`, `core/more`, `core/file` and `core/verse`. v2 keeps these blocks unchanged but can't write new ones.
- The ACF container passthrough and the site-config custom-block passthrough (`docs/custom-block-support.md`). v2 needs a per-site fixture pass instead.
- Finding the target post from the message, for example "update the last post". v2 needs a post ID (v2 roadmap, Phase 5).
- Plans with several actions, or several posts, in one request.
- SEO fields on sites without Yoast. v1 wrote `_sitepilot_seo_*` meta, which nothing reads.
- Approval bypass, dry run, the reviewed screenshot-analysis step, heuristic clarification questions and provider cost tracking.

Categories and tags are not lost: neither engine can set them today (`v2-roadmap.md:32`).

### 1.2 Steps

Do this on its own branch, and commit after each step, so any step can be reverted on its own.

**Step 1: Move the tests to v2 first.**
- Keep the script names, so habits and docs still work, and point them at v2:

  | Script | Runs |
  | --- | --- |
  | `test:e2e:smoke` | `v2-chat` |
  | `test:e2e:content` | `v2-chat`, `v2` (`v2-gutenberg.ts`) and `mcp` |
  | `test:e2e:all` | content, plus `v2-status`, then `v2-seo` and `v2-acf` where the site supports them, plus `v2-long-post` when an OpenAI key is set |

- Add a v2 onboarding E2E that runs register, discovery and activation, to replace what `run.ts` covered.
- Rewrite `AGENTS.md`. Update the suite descriptions, and replace the v1 trigger files with the v2 ones: `gutenberg-v2-*`, `packages/gutenberg-worker`, `plugins/wordpress-sitepilot/includes/V2/`, `assets/js/editor-bridge.js`, `packages/mcp-server` and `mcp-backend.ts`.
- Update the test commands in `README.md:46-57` and `AUTOMATED_TESTING.md`.

**Step 2: Fix what depends on v1 before deleting it.**
- **Conversations handoff.** `chat-service.ts:365` passes `contentEngine: "gutenberg_v2"`.
- **Ingress.** `request-ingress-service.ts` drops the v1 planning path (lines 25, 49-56 and 145-160).
- **Request bundle.** `request-bundle-service.ts` shrinks to the request and its attachments. Move or drop `applyApprovalBypass` and `deriveRequestStatusAfterPlanning`, which it imports from `plan-generation-service.ts`.
- **Thread delete.** It must keep deleting the v1 rows, because foreign keys are on (`packages/repositories/src/sqlite.ts:34`).
  - It never deletes `gutenberg_v2_request_executions` or `request_visual_analyses` rows, both of which reference `requests`. So deleting a thread that ran a v2 request probably fails today.
  - Write a failing test first to confirm, then add both tables to the cascade in `chat-service.ts:565-761`.
- **Open v1 requests.** Add migration `008` to close any open request with `content_engine = 'v1'`, with a note: "SitePilot no longer runs the old engine. Start a new request." A follow-up on those requests already fails with `request_engine_conflict`.
- **The v2 kill-switch.** As decided in Phase 0, `SITEPILOT_V2_ENABLED=false` becomes "SitePilot can't write to this site". Update the settings-page text, and the out-of-date "disabled-by-default" comment in `tests/e2e/wordpress/sitepilot-v2-test-flag.php`.

**Step 3: Delete the desktop and package code.**
- **`apps/desktop/src/main`:**
  - `execution-orchestrator-service.ts`
  - `plan-generation-service.ts`
  - `approval-workflow-service.ts`
  - `request-visual-analysis-service.ts`
  - `planner-context-service.ts`
  - `planner-skills-service.ts`
  - `image-sourcing-service.ts`
  - `apps/desktop/planner-skills/`, including its entry in the `files` block of `apps/desktop/package.json:50`
- **`ipc.ts` handlers:** `executePlanAction`, `generateActionPlan`, `decideApproval`, `listPendingApprovals`, visual analysis, `buildPlannerContext`, and the plan parts of `getRequestBundle` and `ingestThreadMessage`. Remove the matching preload entries (`preload/index.ts:60-76`) and contract channels and schemas (`packages/contracts/src/ipc.ts`).
- **`packages/services`:**
  - `generate-action-plan.ts`
  - `mcp-action-map.ts`
  - `plan-post-lookup-enrichment.ts`
  - `planner-context.ts`
  - `request-visual-analysis.ts`
  - their `exports` subpaths in `package.json`
  - `clarification-engine.ts` and `post-type-intent.ts`, once the handoff fix is in
  - **Keep `post-target-resolution.ts` and its test**, because `v2-expansion-plan.md:241` plans to reuse it.
- **`packages/validation`:** the whole package, plus its entries in `tsconfig.base.json:25` and in the `apps/desktop` and `services` `package.json` files.
- **`packages/contracts`:**
  - **Delete:**
    - from `schemas.ts`: the v1 plan, action, parsed-block, approval-payload, planner-context, visual-analysis and tool-invocation schemas, `bypassApprovalRequests` and the retired `gutenbergV2Enabled`;
    - from `core-block-support.ts`: the v1 support lists and the `find*`/`explainUnsupported*` helpers.
  - **Keep:** `ALL_WORDPRESS_CORE_BLOCK_NAMES`, `coreBlockLabel`, `classifyDiscoveredCustomBlock` and `normalizeParsedBlockName`, which discovery and site settings use.
- **`packages/domain`:** the v1 types, only as far as the repositories that use them allow. Keep every table (see step 5).
- **`packages/provider-adapters`:** `estimateUsageCostUsd`, if nothing else uses it.
- **Renderer:**
  - `chat/plan-actions.ts`
  - the v1 half of `DeveloperPanel.tsx`
  - `NextActionCard`, `ReferenceAnalysisPanel`, `DryRunPreviewPanel` and `PlanNextSteps` in `RequestPanel.tsx`
  - the v1 branches of `chat-workflow.ts` and `request-view.ts`
  - `debug-export.ts:104-115`
  - the v1 half of `ApprovalsPage.tsx`
  - the Composer's hidden "Standard planner" option
  - the approval-bypass section of `SiteSettingsPage.tsx:533-575`
  - Delete the services imports in `ChatPage.tsx:23`, `DeveloperPanel.tsx:3`, `request-view.ts:4` and `plan-actions.ts:4` in the same commit as the modules, or the build breaks.
- **Also trim:** the v1 reply text and `countRunnableActions` in `chat-service.ts`, `claimV1RequestEngine` in `gutenberg-v2-chat-service.ts`, the site planner settings in `settings-service.ts`, and the v1 collision check in `tests/e2e/v2-chat.ts:33, 399-406`.
- **Keep the `latest_plan_id` guards** in `gutenberg-v2-chat-service.ts`, so old v1 requests stay protected.
- **Tests:**
  - **Delete** the v1-only unit tests: `execution-orchestrator-service`, `generate-action-plan`, `image-sourcing-service`, `mcp-action-map`, `plan-generation-service`, `plan-post-lookup-enrichment`, `plan-validation`, `planner-context` and `clarification-engine`.
  - **Edit** the mixed ones: `request-ingress-service`, `call-context`, `chat-workflow`, `chat-service`, `site-planner-settings`, `request-bundle-service`, `contracts-schemas`, `ipc-contracts`, `sqlite-repositories` and `integration-workflow`.
  - **Delete from `tests/e2e`:** `run.ts`, `run-suite.ts`, `open-report.ts`, the `fixtures/*.plan.json` files and `automated-test/*.txt`. Check whether anything else uses `fixtures/test.jpeg` and `fixtures/test.mp4` before deleting them.

**Step 4: Delete the plugin's v1 code.**
- **Delete:** `includes/Mcp/Write_Abilities.php` (2,778 lines) and `tests/WriteAbilitiesTest.php`.
- **Unwire it:**
  - Remove its registration in `Plugin.php`.
  - Remove the five write abilities from `Server_Registrar.php`, and change its description from "read and vetted writes" to read-only.
- **Also delete:**
  - `V2\Acf_Blocks::normalize_data`, whose only caller besides its own test was `Write_Abilities`;
  - the `site-summary` read ability, which nothing calls.
- **Keep:**
  - the `find-posts`, `get-post`, `site-discovery` and `ping` abilities, which Conversations, content search, discovery and the MCP lookups use;
  - `Post_Query`, `Site_Discovery` and `Seo_Adapter`;
  - **the `/wp-json/sitepilot/v1/{health,protocol,register}` routes.** Their `v1` is the REST namespace, not the v1 engine.
- **Version.** Bump the plugin version and say in the changelog that the write abilities are gone. Sites on older plugins still expose them until they update; the desktop simply stops calling them. Update every managed site, since T2 is only fixed on updated sites.

**Step 5: Old data and history.**
- **Keep every v1 table.** Dropping them buys nothing, and the thread-delete cascade still needs them.
- **Old threads stay readable,** because chat messages persist. For v1 requests, the side panel shows a read-only note: "Made with the old engine", the planned action count and the last run status. There are no Execute buttons.

**Step 6: Docs.**
- **Move to `docs/archive/v1/`,** with a one-line note at the top of each:
  - `reliable-gutenberg-blocks.md`
  - `chat-execution-regression-guardrails.md`
  - `task-graph.md`
  - `planner-skills.md`
  - `block-promotion-workflow.md`
  - `screenshot-analysis-workflow.md`
  - `custom-block-support.md`
- **Update the v1 references in:**
  - `system-overview.md:128-130, 181`
  - `architecture.md`, in the action-plan sections
  - `v2-implementation.md:3, 133-183`
  - `v2-build.md:38, 146, 195`
  - `v2-mcp-plan.md:112, 186, 323`
  - `v2-expansion-plan.md`
  - `plugins/wordpress-sitepilot/README.md:5`
  - `SPEC.md`, where it describes action plans

**Exit:**
- No imports of the deleted modules remain. `npx tsc -b` passes on Node 22, and so do vitest and the renderer build.
- PHPUnit passes.
- The new `test:e2e:smoke`, `test:e2e:content` and `test:e2e:all` pass against the MAMP site, and so does the new onboarding E2E.
- Unit tests show that deleting an old v1 thread and a v2 thread both work with foreign keys on.
- An old v1 thread opens read-only, with no Execute button.
- A Conversation's "turn this into a request" creates a v2 request.

## Phase 2: Trust fixes (M)

### 2.1 Registration and identity (T1, T3)

- **T1, the code.** Consume the code on a successful registration and generate a new one. Show the code on the settings page only after an admin clicks "Show code", and add a "Reset code" button.
- **T1, takeovers.** Refuse a `siteId` that already exists unless the request is signed with that site's current secret. That turns re-registration into a rotation, not a takeover.
- **T3.** Require a mapped WordPress user at registration, and refuse signed calls for a site without one. Drop the fallback to the first administrator.
- **Client list.** List registered clients on the settings page, with a Revoke button.

### 2.2 Access and replay (T2, T5, T6, T8)

- **T8.** Require the signature on the plugin MCP route. Remove the logged-in shortcut from `check_access`.
- **T5.** Read abilities return non-public statuses only when the mapped user has `edit_posts` (or `edit_post` for a single post).
- **T6.** Make the nonce check atomic: an `add_option` row with a unique key, cleaned up by cron, instead of a transient check-then-set.
- **T2 regression test.** A signed call whose mapped user lacks `edit_post` is refused on every v2 write route.

**Exit:**
- PHPUnit covers:
  - code rotation, and refusing to overwrite an existing site;
  - refusing a site with no mapped user;
  - the MCP route refusing an unsigned logged-in user;
  - subscribers not seeing draft titles;
  - a parallel nonce replay;
  - the T2 regression test.
- `npm run test:e2e:content` passes after re-registering the MAMP site.

## Phase 3: Safe URL fetching (S, T4)

### 3.1 One fetch helper

Add a `safeFetch` module to `packages/services`, with no Electron imports, so the hosted worker can use it later:

- **Addresses.** Resolve DNS once and refuse loopback, private, link-local, CGNAT, multicast, unspecified and IPv6 unique-local addresses. That includes IPv4-mapped forms and `169.254.169.254`. Connect to the IP that was checked, using an undici `Agent` with a fixed `lookup`, so DNS rebinding can't switch it.
- **Redirects.** Follow at most three, by hand, and check each hop again.
- **Schemes.** Allow `https`, plus public `http` for page research only, as decided in Phase 0.
- **Limits.** Set a timeout and a streamed size cap for each use: 10 MB for images, 2 MB for pages.
- **File types.** Decide them from magic bytes with `detectGutenbergV2MediaType`. Allow JPEG, PNG, WebP and GIF. Refuse SVG.
- **One exception.** Allow the registered site's own origin, since local dev sites resolve to loopback.

Route every fetch that takes an outside URL through it. After Phase 1 that's `fetchExternalPageText`, reached from Conversations and the MCP `ask` tool. The image search and v1 download are deleted in Phase 1. If images by URL come back later as a v2 feature, they must use this helper.

Add timeouts and body caps to `site-fetch.ts` and `signed-fetch.ts` at the same time.

### 3.2 Plugin uploads

- `Media_Service`: delete the written file when the content check fails (`Media_Service.php:366-388`).
- `media-bindings` creates attachments before anything is approved. Leave that as it is for now; Phase 7 requires a proof for it.

**Exit:**
- Unit tests cover:
  - each blocked address range;
  - a redirect to loopback;
  - a DNS answer that changes between lookups;
  - oversized bodies;
  - a spoofed `Content-Type`;
  - SVG.
- An E2E check shows that a pasted `http://127.0.0.1` link and a redirect to it are both refused, in a Conversation and through the MCP `ask` tool.
- `npm run test:e2e:content` passes.

## Phase 4: One error format (M–L)

### 4.1 The contract

Add `sitepilot.error/v1` to `packages/contracts`:

```ts
{ code: string; cause: ErrorCause; retryable: boolean; message: string;
  details?: Record<string, unknown>; auth?: { reason: AuthFailureReason } }
```

- **`ErrorCause`:** `auth`, `capability`, `not_found`, `invalid_input`, `stale`, `conflict`, `approval_required`, `not_supported`, `host_environment`, `wp_core`, `filesystem`, `render_failed` or `internal`.
- **`AuthFailureReason`:** reuse the vocabulary in `packages/plugin-protocol/src/validate.ts`, and add `unknown_site`, `no_mapped_user`, `client_mismatch`, `signature_invalid`, `headers_missing` and `nonce_replayed`.
- Messages stay plain language. Codes are for machines.
- Advertised as `error_contract_v1` in `/protocol`.

### 4.2 Plugin

- **One helper for every error.** Replace the private `error()` helpers with a single `SitePilot\Errors\Error_Contract`. It puts `code`, `cause`, `retry_ok` and `details` in the `WP_Error` data.
- **Small bugs to fix here:**
  - the double prefix in `Editor_Session.php:282`, which produces `sitepilot_v2_sitepilot_v2_read_only`;
  - `Feature::disabled_error()` has no code;
  - registration errors have no `data.code`;
  - `Media_Service.php:501` returns 503 for every error;
  - `Acf_Blocks` messages aren't translated.
- **Auth reasons.** `Signed_Request_Verifier::verify_*` returns a reason instead of a bool, and the route turns it into an `auth` error. The reason is safe to show. Values derived from the secret are not.
- **Structured MCP auth errors.** The vendored adapter replaces a `WP_Error` from the transport callback with its default check. So emit the structured error from `rest_request_before_callbacks` for the SitePilot MCP route instead.
- **Stripped headers.** Add a signed `/sitepilot/v1/echo-headers` diagnostic that reports which `X-SitePilot-*` headers arrived. The desktop's connectivity check can then say "your host removed X-SitePilot-Signature".
- **Read ability results.** The in-band `{ ok: false, error: "<string>" }` from `Post_Query` and the read abilities becomes the contract object. The TypeScript parser accepts the old string during the transition.

### 4.3 Desktop, MCP server and planner

- **One parser.** `parseSitePilotError` replaces the parsing in `wordpress-transport.ts:292-332` and `session-client.ts:65-104`.
  - Unknown codes default to `retryable: false`.
  - A non-JSON 5xx becomes `host_environment`, with the first bytes of the body in `details`.
- **`packages/mcp-client`:**
  - Check `response.ok` before `JSON.parse`.
  - Honour `isError` in `callTool`.
  - Keep `isError` in `normalizeMcpToolResult`.
- **Merge the two `createMcpClientForSite` versions.** Keep one set of `site_*` codes.
- **MCP server:**
  - Tool failures return `structuredContent` with the contract, plus the text line.
  - `recordToolCall` records the `code`.
  - `request_status` returns the failure `code`, `cause` and `retryable`.
- **Keep the codes.** `errorResult` in `gutenberg-v2-chat-service.ts` keeps `retryable` and `issues`.
- **Planner feedback.** The conversation agent passes the structured error to the model instead of `e.message` (`conversation-service.ts:578-599`, `:807`).
- **Check the retry flag.** Confirm what `ExecutionResult.retry.retryable = state === "manual_intervention_required"` is meant to say (`gutenberg-v2-content-service.ts:1679`), and fix either it or the report text to match.

**Exit:**
- Every plugin route and ability error has a `code`, a `cause` and `retry_ok`. A PHPUnit test walks the registered routes to check.
- The desktop has one parser, with unit tests for the old and new shapes.
- `npm run test:e2e:mcp` asserts a structured error for an unknown site.
- `npm run test:e2e:all` (the v2 version from Phase 1) passes, since this phase spans planning and execution.

## Phase 5: Retry-safe writes (S)

v2 is already replay-safe. After Phase 1 there are no v1 writes left to fix. What remains:

- Mark permanent `/commit` refusals (`stale_source`, `idempotency_conflict`, approval errors) as not retryable. The job then moves to a failed state instead of staying in `committing`.
- Add timeouts to `SignedWordPressV2Transport` writes. After a timeout, reconcile automatically once before showing Retry.
- Add a regression test that a lost `/commit` response followed by Retry gives one write. This case is verified by hand in `v2-implementation.md:169`, but no test covers it.

**Exit:** unit tests for the retry classification and the timeout-then-reconcile path. The content E2E suite passes.

## Phase 6: Render check after apply (M)

### 6.1 Plugin

Add a signed `/sitepilot/v2/render-check` route, advertised as `render_check_v1`.

- **How it renders.** It renders the persisted post content in-process: `apply_filters( 'the_content', … )` inside output buffering, with an error handler and a `Throwable` catch. That's the same pattern as `Acf_Blocks::render_failure`.
- **What it returns.** One of `ok`, `render_error` (with the block name and message) or `empty_output`.
- **True fatals.** Running out of memory or time kills the request itself. The desktop treats a non-JSON 500 from this route as `render_failed`, not as a retryable `editor_unavailable`.

### 6.2 Desktop

- **Compare before and after.** For existing posts, take a baseline at prepare time and check again after commit. Roll back only if the baseline was healthy and the new render is broken. That way a theme error that was already there doesn't block every edit.
- **Check the preview page too.** Fetch it in the worker's existing session. Check the status and look for the WordPress critical-error page ("There has been a critical error on this website" and its `wp-die` markup).
- **Published posts.** Change `checkPublicUrl` to keep the body and apply the same check.
- **Wiring.** Put the check into `verifyPersistedContent`, before the success decision (`gutenberg-v2-content-service.ts:1049-1058`).
  - An existing post that fails goes through the existing `conditionalRollback`.
  - A new draft that fails is kept, and the job is marked failed with the render error as the reason (Phase 0).

**Exit:**
- A test-only mu-plugin on the MAMP site makes one ACF block template throw for a marker attribute.
- An E2E scenario that adds that block ends `rolled_back` for an existing post.
- The same scenario ends failed for a new draft, with the draft kept and the reason shown.
- The content E2E suite passes.

## Phase 7: Signed approval proofs (M)

### 7.1 Why the audit log isn't enough

The desktop's audit log records who approved and applied each change, after the fact, in SitePilot's own database. That is enough while one desktop approves, applies and logs everything. It can't stop a write, though. It only sees writes that go through SitePilot. And anyone with access to the desktop's database can change it.

A proof is checked by the WordPress plugin before it writes. That matters in three cases:
- **Approval and applying happen in different places**, as with the hosted backend and Slack.
- **Someone holds the site's connection secret** and writes to the plugin directly, without going through SitePilot.
- **A client needs the site itself to guarantee** that every change was approved.

The desktop-only setup gets benefits 1, 4 and 5 below straight away. Benefits 2 and 3 grow once the hosted app or Slack approves changes.

### 7.2 Benefits

1. **The website itself refuses unapproved changes.** Today only SitePilot enforces approval. With proofs, WordPress checks every change before saving it, so even a bug in SitePilot can't push through a change nobody approved.
2. **A stolen connection secret can't change content.** Today, anyone who gets the site's connection secret can write to the site with a made-up approval. With proofs, they'd also need the approval key.
3. **Approving and applying can safely happen in different places.** When approval moves to Slack or the hosted app, the worker that applies changes can't approve its own work. Nobody can slip an extra change into its queue either.
4. **What was reviewed is exactly what gets written.** Each proof is tied to the exact content and images someone approved: the hashes the review previews were made from. Anything changed after review is refused.
5. **Each approval works once and then expires.** It can't be reused to repeat the change later. The plugin caps how long an approval stays valid. Today the desktop picks the expiry, with no cap.
6. **The site keeps its own tamper-proof record of who approved each change.** It doesn't depend on SitePilot's database, which is useful for agencies, clients and audits.
7. **It gives you a strong selling point:** "every change is approved by a named person, and the website checks it." WPVibe only asks for approval on irreversible actions.
8. **It leaves room for stricter rules later.** For example, publishing could need a manager's approval, or some changes could need two approvers.

### 7.3 Costs and limits

- Key storage and rotation, on the desktop and later on the hosted backend.
- One more thing that can fail: an expired proof, or clock skew. Errors use Phase 4's `approval_required` cause with a clear reason.
- While one desktop holds both the connection secret and the approval key, benefit 2 is limited: stealing one probably means stealing both. The full benefit comes when they're held by different components.

### 7.4 Design

- **A separate key.** An Ed25519 approval key, separate from the request HMAC secret. The desktop keeps it in safeStorage, and the hosted backend keeps it in its secrets store or KMS. The plugin stores the public key when the site registers or rotates (Phase 2.1), and returns its fingerprint in `/protocol` alongside `approval_proof_v1`.
- **What the proof signs:** the site audience, `candidateId`, `approvalId`, `approverId`, the approval binding hash, `expiresAt` (at most 30 minutes after approval) and a key ID.
- **Where the plugin checks it:** `prepare`, `media-bindings` and `commit`. At each it checks:
  - the signature;
  - that the binding matches;
  - that the proof hasn't expired;
  - that the `approvalId` is used by one execution only (`add_option`).
- **Status changes.** A publish or unpublish candidate gets its own proof.
- **Registering the key.** The desktop generates its approval key on first use. It registers the public key automatically, with a request signed by the site's current secret, when a site advertises `approval_proof_v1`. This uses Phase 2.1's signed rotation.
- **Enforcement.** Once a site has an approval key registered, the plugin requires a proof on every v2 write from that site. Sites on older plugins keep working without proofs until they update. The settings page shows whether proofs are required.
- **The plugin's own record.** It stores `approverId`, `approvalId` and the key ID with the commit receipt.
- **Rotation.** Keys carry an ID. Registration rotation replaces them.

**Exit:**
- PHPUnit: a made-up approval, a changed binding, an expired proof and a reused `approvalId` are all refused.
- E2E: a v2 apply on a site that requires proofs succeeds with a real approval, and fails when the proof is removed.
- The full E2E suite passes.

## Order and parallel work

1. Phase 1, step 1 (moving the tests to v2) first, because every later check depends on it. Then the rest of Phase 1 and Phase 2 in parallel. They touch different files, except the ability list in `Server_Registrar.php`, which Phase 1 trims.
2. Phase 3 alongside them. After Phase 1 it only covers page research, so it's small.
3. Phase 4 next. Phases 5 and 6 use its codes.
4. Phases 5 and 6 in parallel.
5. Phase 7 after Phase 2, which it needs for signed key registration. It uses Phase 4's `approval_required` codes if they're ready, and can start before they are.

## Testing

- PHPUnit for each plugin change (`vendor/bin/phpunit` in `plugins/wordpress-sitepilot`).
- Vitest for `safeFetch`, the error parser and the retry classification.
- Every phase touches `apps/desktop/src/main/`, `packages/*` or `plugins/wordpress-sitepilot/includes/`. So each increment runs `npm run test:e2e:content`. That means the v1 suite until Phase 1 step 1 lands, and the v2 suite after it.
  - Phases 1, 4 and 7 span planning and execution, so they run the full suite.
  - Run `npm run test:e2e:mcp` whenever MCP errors or tools change.
- The MAMP site runs a copied plugin, so sync it before WordPress E2E.
- Don't run E2E against the shared site while another session is using it. Runs re-register the site and log in as the same user.

## Open questions

- Should a failed render check on a published post roll back the publish as well as the content? Recommendation: yes. The publish step already has a status rollback.
