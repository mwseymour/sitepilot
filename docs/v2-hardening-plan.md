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
| T4 | **A pasted link can read local services.** Page research follows redirects to any address, `http` included, and returns the page text. The MCP `ask` tool reaches the same path. So the MAMP admin, localhost dev servers, the cloud metadata address and LAN admin pages are all reachable. Image search validation only checks the first URL and follows redirects unchecked. The v1 image download has no checks at all. | `external-page-research-service.ts:107-125`, `image-sourcing-service.ts:186-213`, `execution-orchestrator-service.ts:665-752` | Phase 3. The v1 download goes in Phase 1. |
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
5. **Signed approvals wait for the hosted backend.** They depend on the registration fixes, and they only add much once approval and applying happen in different places (Phase 5 of the [MCP plan](./v2-mcp-plan.md#phase-5-hosted-backend-l)).

## Phase 0: Decisions

### Decided on 29 September 2026

| Decision | Outcome |
| --- | --- |
| v1 | **Remove v1 now**, rather than hardening or freezing it. See [Phase 1](#phase-1-remove-v1-l). |
| What the render check does for a new draft | **Keep the draft and mark the job failed with the reason.** Don't delete it. That matches the draft-retention rule in `v2-build.md:207`. |
| Compatibility across plugin versions | **Add a `features` list to `/protocol`**, for example `error_contract_v1`, `render_check_v1` and `approval_proof_v1`. Sites update the plugin separately from the desktop, so the desktop uses a feature only when the site advertises it, and keeps parsing the old error shapes. |

### Still open

| Decision | Blocks | Recommendation |
| --- | --- | --- |
| Whether to build approval proofs now | Phase 7 | Not now. Build them with the hosted backend (MCP plan, Phase 5), when approval and applying first happen in different places. Until then the desktop's audit log covers who approved what (see 7.1). Once built, opt in per site first, and require them before the hosted backend applies anything. |
| Whether page research may fetch `http://` | Phase 3 | Allow it for public addresses only, after the IP checks. |

## Phase 1: Remove v1 (L)

Scope is being mapped. This section will list:

- every v1 entry point;
- which modules to delete, keep or change;
- the E2E suites that replace the v1 ones in `AGENTS.md`;
- what happens to existing v1 history;
- the v1 features that v2 doesn't have yet.

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

## Phase 3: Safe URL fetching (M, T4)

### 3.1 One fetch helper

Add a `safeFetch` module to `packages/services`, with no Electron imports, so the hosted worker can use it later:

- **Addresses.** Resolve DNS once and refuse loopback, private, link-local, CGNAT, multicast, unspecified and IPv6 unique-local addresses. That includes IPv4-mapped forms and `169.254.169.254`. Connect to the IP that was checked, using an undici `Agent` with a fixed `lookup`, so DNS rebinding can't switch it.
- **Redirects.** Follow at most three, by hand, and check each hop again.
- **Schemes.** Allow `https`, plus public `http` for page research only (Phase 0).
- **Limits.** Set a timeout and a streamed size cap for each use: 10 MB for images, 2 MB for pages.
- **File types.** Decide them from magic bytes with `detectGutenbergV2MediaType`. Allow JPEG, PNG, WebP and GIF. Refuse SVG.
- **One exception.** Allow the registered site's own origin, since local dev sites resolve to loopback.

Route every fetch that takes an outside URL through it:
- `fetchExternalPageText`;
- `validateDirectImageUrl` and `fetchJson` in `image-sourcing-service.ts`, if Phase 1 keeps that module.

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
- The E2E suite that replaces `test:e2e:all` (Phase 1) passes, since this phase spans planning and execution.

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

## Phase 7: Signed approval proofs (M, with the hosted backend)

### 7.1 Why the audit log isn't the same thing

The desktop's audit log records who approved and applied each change, after the fact, in SitePilot's own database. That is enough while one desktop approves, applies and logs everything. It can't stop a write, though. It only sees writes that go through SitePilot. And anyone with access to the desktop's database can change it.

A proof is checked by the WordPress plugin before it writes. That matters in three cases:
- **Approval and applying happen in different places**, as with the hosted backend and Slack.
- **Someone holds the site's connection secret** and writes to the plugin directly, without going through SitePilot.
- **A client needs the site itself to guarantee** that every change was approved.

None of these apply to the desktop-only setup, so this phase waits for the hosted backend.

### 7.2 Benefits

1. **The site enforces approval, not just SitePilot.** No write lands in WordPress without a person's approval, even if a SitePilot code path has a bug. The v1 path that checked a request status instead of an approval is the kind of bug this catches.
2. **A leaked connection secret isn't enough.** Today the site's secret alone lets someone prepare and commit a change with a made-up approval. With proofs, they also need the approval key.
3. **Approval can safely happen somewhere else.** With the hosted backend and Slack, approval happens in one place and applying in another. The worker that applies changes can't approve its own work, and tampering with the job queue can't slip in an unapproved change.
4. **What was reviewed is what gets written, and the site checks it.** The proof covers the content and media hashes that the review previews were made from. The plugin already recomputes those hashes; the proof makes the binding itself trustworthy.
5. **One approval, one change.** Each `approvalId` can be used once, and the plugin caps how long an approval stays valid. Today the desktop picks the expiry, with no cap.
6. **A record on the site that doesn't depend on SitePilot's database.** The plugin can log who approved each change, from a signed statement. That's useful for agencies, clients and audits.
7. **A clear claim for positioning.** "Every change is approved by a named person, and the site itself checks it." WPVibe only asks for approval on irreversible actions.
8. **Room for policy later.** For example, publishing could require a publisher's key, or some changes could need two approvers.

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
- **The plugin's own record.** It stores `approverId`, `approvalId` and the key ID with the commit receipt.
- **Rotation.** Keys carry an ID. Registration rotation replaces them.

**Exit:**
- PHPUnit: a made-up approval, a changed binding, an expired proof and a reused `approvalId` are all refused.
- E2E: a v2 apply on a site that requires proofs succeeds with a real approval, and fails when the proof is removed.
- The full E2E suite passes.

## Order and parallel work

1. Phases 1 and 2 in parallel. They touch different files. The one shared file is the ability list in `Server_Registrar.php`, which Phase 1 trims.
2. Phase 3 alongside them, once Phase 1 has decided whether `image-sourcing-service.ts` stays.
3. Phase 4 next. Phases 5 and 6 use its codes.
4. Phases 5 and 6 in parallel.
5. Phase 7 later, with the hosted backend (MCP plan, Phase 5). It needs Phase 2's registration rotation first.

## Testing

- PHPUnit for each plugin change (`vendor/bin/phpunit` in `plugins/wordpress-sitepilot`).
- Vitest for `safeFetch`, the error parser and the retry classification.
- Every phase touches `apps/desktop/src/main/`, `packages/*` or `plugins/wordpress-sitepilot/includes/`. So each increment runs the content E2E suite: today that's `npm run test:e2e:content`, and after Phase 1 it's whatever replaces it.
  - Phases 1, 4 and 7 span planning and execution, so they run the full suite.
  - Run `npm run test:e2e:mcp` whenever MCP errors or tools change.
- The MAMP site runs a copied plugin, so sync it before WordPress E2E.
- Don't run E2E against the shared site while another session is using it. Runs re-register the site and log in as the same user.

## Open questions

- Should a failed render check on a published post roll back the publish as well as the content? Recommendation: yes. The publish step already has a status rollback.
