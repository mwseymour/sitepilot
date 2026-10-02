# v2 roadmap

Status: planned, 25 September 2026. This is the forward-looking list for the Gutenberg v2 content engine and the clients that use it.
- For what v2 does today, see [What Gutenberg v2 can do](./v2-capabilities.md).
- Detailed plans for the SEO, publishing and target-resolution phases stay in the [v2 expansion plan](./v2-expansion-plan.md), along with what Phases 0 to 2 (safe editing, new core blocks, ACF blocks) delivered.
- The hosted architecture, including the SitePilot MCP server that Slack, Claude and Codex share, is in [v2 build](./v2-build.md#91-sitepilot-mcp-server).

## Overview

| Item | Plan | Size |
| --- | --- | --- |
| ACF follow-ups: attached media for image and file fields, `usePostMeta` storage, more field types | [Below](#acf-follow-ups) | M |
| Third-party blocks, set up per site by an admin | [Below](#third-party-blocks-set-up-per-site) | L |
| SEO fields (Yoast first) | [Expansion plan, Phase 3](./v2-expansion-plan.md#phase-3-seo-fields) | M |
| Publish, unpublish and schedule | [Expansion plan, Phase 4](./v2-expansion-plan.md#phase-4-publish-and-unpublish) | M |
| Choosing a request's post from the message | [Expansion plan, Phase 5](./v2-expansion-plan.md#phase-5-resolving-a-requests-target-from-text-sm) | S–M |
| Categories and tags | [Below](#categories-and-tags) | M |
| Lookup registry and extensible conversations | [Below](#lookup-registry-and-extensible-conversations) | M–L |
| SitePilot MCP server (Slack, Claude, Codex) | [MCP and Slack plan](./v2-mcp-plan.md), [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server) and [below](#mcp-server) | L |
| Streaming upload for videos over 10 MB | [Below](#large-media-uploads) | M |
| Staging sites, with promotion to live (idea) | [Below](#staging-sites-and-promotion-to-live) | L |

**Shared prerequisite.** SEO fields, and categories and tags, both need non-string post fields. Today `requestedPostFields()` in `packages/services/src/gutenberg-v2-content-service.ts` keeps string values only. They also need a staleness hash separate from `fields_hash`. Do that contract work once, for both.

**Suggested order:**
1. The lookup registry. It unblocks the MCP server, and every later phase adds lookups to it.
2. Categories and tags together with SEO, since they share a prerequisite.
3. Publishing and target resolution.
4. The MCP server, then the Slack app as its client.
5. ACF follow-ups, third-party blocks and large media uploads, as sites need them.

## Categories and tags

v2 can't set taxonomy terms today, and v1 couldn't either. The only uses of a category are as a lookup filter (`find-posts`), and in discovery, which records which public taxonomies exist but not their terms.

### Discovery (S)

- For each post type, capture the taxonomies registered for it: slug, label, whether it is hierarchical, and whether it appears in the REST API.
- Capture their terms, up to a bound, with ID, slug, name and parent. Refresh them when a request starts, since terms change often.
- Start with `category` and `post_tag`. Add custom taxonomies once the site config allowlists them.

### Contract (M)

- Add `postFields.terms`, keyed by taxonomy.
  - Each taxonomy entry either replaces the set (`set`) or makes a change (`add` / `remove`). A replace and a change can't be mixed.
  - Terms are named by existing ID or slug.
- A **new term** is only allowed when the request asks for it. It is named explicitly and shown in review as "Create new tag: …". The site config can turn new-term creation off.
- The planner receives the available terms. SitePilot matches the model's names to existing terms (ignoring case and punctuation) outside the model, and anything unmatched becomes a proposed new term rather than a guess. Hierarchical categories are matched by their full path when names repeat.
- The approval binds the resolved term IDs, via the shared prerequisite. The staleness check also covers the post's current terms, so a later human change blocks the write.

### Commit and verification (M)

- **New terms:** created at prepare time through a durable journal, so a retry never duplicates them. A new term that no commit ended up using is recorded for cleanup, like orphaned media.
- **Assignment:** `wp_set_object_terms` runs inside the commit transaction. WordPress's default category is removed when a real category is set.
- **Permissions:** assigning uses the taxonomy's `assign_terms` capability, and creating uses `edit_terms` (for categories, `manage_categories`).
- **Rollback:** the before-state records the terms, and rollback restores them only if the post still has the terms this write set.
- **Readback:** confirms the exact term IDs.
- **Review:** shows categories and tags as before → after.

### Conversations

Add `list_terms`, and allow term filters in `query_content` (see the next section). Then "which posts are tagged X" and "what categories exist" work.

## Lookup registry and extensible conversations

People will keep finding questions the current lookups can't answer. Adding a lookup should be cheap, and safe by default. Today the desktop Conversations service hardcodes two tools and an argument allowlist (`apps/desktop/src/main/conversation-service.ts`).

### 1. One shared registry (M)

- Move read tools into one registry, for example `packages/services/src/read-tool-registry.ts`.
- The desktop Conversations service, the MCP server and the Slack app all read from it. A lookup added once appears in all three.
- The conversation agent builds its tool list and descriptions from the registry, instead of from a hand-written prompt. The current `sitepilot-find-posts` and `sitepilot-get-post` wiring moves onto it.

### 2. Lookups come from read-only plugin abilities (M)

- A lookup is a WordPress plugin ability annotated `readonly: true`, as `find-posts` and `get-post` already are, plus an entry in a SitePilot allowlist.
- SitePilot builds the model-facing tool from the ability's own input and output schema. Adding a lookup means registering the ability in the plugin and allowlisting it, with no hand wiring.
- An ability that is not marked read-only can never enter the registry.
- The plugin also refuses to run a registry call against an ability that is not read-only, so the rule does not depend on the desktop app alone.

### 3. One flexible query, plus narrow tools (M)

- `query_content`, a structured query with:
  - post type and status
  - taxonomy terms, date range and author
  - allowlisted meta keys
  - the fields to return
  - sorting and a limit

  This covers most new questions without new code.
- Narrow tools where the shape really differs:
  - `list_terms`
  - `get_revisions` (who changed what and when, with a short diff summary)
  - `search_media` (library items with type, size, alt text and where they are used)
  - `list_menus`
  - `site_summary` (from discovery)
  - `find_block_usage` (posts that contain a given block, for example "which posts use the old banner")
- A few well-described tools work better for models than one do-everything tool, so a new narrow tool is added only when `query_content` can't express the question.

### 4. Guardrails for every lookup (S)

- Read-only is enforced on the server, not just labelled.
- Results are bounded and truncated, with a stated count of what was left out.
- Site content is returned marked as untrusted data, never as instructions.
- Sensitive data stays off unless explicitly allowlisted: user emails, options, private or protected meta, draft content from other authors the requester cannot read.
- WordPress capability checks run as the requesting user.
- Lookups need the MCP `read` scope, and each call is audited with the client, user and tool.

### 5. Learn what people ask for (S)

- When no tool fits, the assistant says so plainly ("I can't look that up yet") instead of guessing. The agent's reply format gains an `unsupported` flag with a one-line description of what was needed.
- SitePilot records those as lookup gaps: the question, what was needed, the client, the site and the date. There is a retention period, and no site content is stored.
- The Diagnostics page lists them, grouped by need, as the backlog for new lookups.

## MCP server

The design is in [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server), and the phased implementation plan is in [MCP and Slack plan](./v2-mcp-plan.md). The Slack app is built as a client of the server, and Claude and Codex connect to the same server. Order of work:

1. The lookup registry above, exposed as the read tools.
2. OAuth 2.1, mapping users to roles, scopes, audit and rate limits.
3. `create_conversation` and `ask`, on the Conversations service, so every client can start and continue read-only research.
4. `create_request`, `add_to_request` and `request_status`, on the existing `ingestThreadMessage` entry point.
5. The review page and approval links. No tool can approve.
6. The Slack app as an MCP client: slash commands that start a Request or a Conversation, a Slack-thread-to-thread mapping, and approval buttons.
7. `submit_block_plan`, only after the organisation's LLM policy allows client-side planning.

**Requirement: chat users need no app.** People who use SitePilot only through Slack can run the whole workflow there: request, revise, review the preview, approve, apply, publish and see the result. This needs the hosted backend, since Slack can't reach an app on someone's Mac. See [MCP and Slack plan, 7.3](./v2-mcp-plan.md#73-the-whole-workflow-in-slack).

**Requirement: one shared thread history.** The hosted app, Slack, Claude and Codex can all create new Requests and Conversations and continue existing ones. Every thread is stored once in the hosted backend and appears in the hosted app, labelled with the client and user that started it, whichever client that was. A thread can be continued from a different client than the one that started it. The desktop app moves onto the hosted backend as another client, so its threads join the same history (see [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server)).

## ACF follow-ups

ACF blocks are discovered, authored from the site's field definitions, and enabled per site after a save-and-reopen fixture passes (expansion plan, Phase 2). Still open:

- **Attached media for ACF image and file fields.** Today these fields take existing media-library IDs only. The fix is to bind them through `mediaRef` like core images: upload after approval, then checksum-verify.
- **`usePostMeta` storage.** Blocks that keep their fields in post meta stay kept-only. Writing them needs the post-meta path from the shared prerequisite above.
- **More field types.** A block with a required gallery, user, Google Map or similar field stays kept-only until that field type has a reviewed shape.
- **Other third-party blocks.** See [Third-party blocks, set up per site](#third-party-blocks-set-up-per-site).

## Third-party blocks, set up per site

Planned, 2 October 2026. Plugin blocks other than ACF blocks (for example a table of contents block, Yoast's FAQ and How-to blocks, or WooCommerce blocks) are kept untouched today. Yoast SEO fields can be edited, but Yoast's blocks can't.

Each site has its own plugins, and one server will run many sites, so supporting a block must not need a code change or a deploy. A site admin sets the block up for that site in the app, the way ACF blocks already work.

**Why not a definition in code for each block.** Core blocks are the same on every site, so their rules live in code (`GUTENBERG_V2_SUPPORT_MATRIX` and `BLOCK_ATTRIBUTE_GUIDANCE`), and a new one ships with a deploy and a plugin update. Third-party blocks differ from site to site, and they change when their plugin updates. ACF already works per site:
- the block's definition comes from the site;
- the test runs on the site;
- the plugin keeps the result (`sitepilot_v2_block_fixtures`).

**Where the definition lives: on the site.** The plugin stores each definition and its test result in WordPress options, not in the SitePilot database:
- The plugin makes the final check when writing (`Block_Policy::authorable_blocks()`), so it has to hold the list anyway.
- The desktop app and the hosted app read the same list.
- A server running many sites needs no per-site code or settings.
- A server bug can't make a site accept a block that the site hasn't passed.

### What the admin does

1. Open **Diagnostics** and run **Test third-party blocks**. A block that builds cleanly shows **Set up**.
2. Check the definition SitePilot drafted from the test, change it if needed, and save it.
3. Run the block's test. When it passes, requests can write the block on that site.
4. If the block's plugin updates and its registered settings change, the block goes back to kept-only until someone runs the test again.

In the hosted app, setting up and testing blocks is limited to admins, like the other diagnostics (`ADMIN_ONLY` in `apps/server/src/app-shell.ts`).

### The definition (M)

The existing probe and usage scan give most of it: each block's settings (type, allowed values, defaults), where it can go, how it renders, and up to three stored examples.

- **Purpose:** one line for the planner on what the block is for and when to use it. It's drafted from the block's title and description, and the admin confirms it.
- **Settings:** each one is either:
  - **set by requests:** the planner may set it, within its type and allowed values;
  - **fixed:** always its default, or a value the admin picks;
  - **set by the block:** left for the block's own editor code to fill, such as a contents block's list of headings. The probe's `changes_when_edited` result shows which settings behave like this.
- **Children:** none, any authorable blocks, or a list. This comes from the block's `allowedBlocks` and whether it holds inner blocks.
- **Fingerprint:** a hash of the block's registered settings and its plugin's version, like ACF's `schemaHash`.
- **Top-level blocks only at first.** Blocks that can only go inside another block wait until their parent can be set up.

The definition is saved through a new signed plugin route, from a new admin-only channel in the app. The plugin returns definitions and their test status from `/block-definitions` (next to `acfBlocks`), and passes them to the editor bridge in `Block_Policy::bridge_config()`.

### The per-site test (M)

Widen the ACF test to these blocks: `runBlockFixtures` (`packages/gutenberg-worker/src/runtime.ts`), the bridge's `blockFixture` and the plugin's `record_fixture`.

- Build the block in the site's own editor with a sample value in every "set by requests" setting. Then save it, reopen it, save it through WordPress and render it, as for ACF.
- Settings marked "set by the block" may change when the block is inserted. Any other change fails the test.
- The plugin repeats the checks it can make itself, and records the result with the fingerprint. A pass adds the block to the site's reviewed list.
- A changed fingerprint (the plugin updated, or its settings changed) turns the block back to kept-only, as a changed field group does for ACF.

### Planning and writing (M)

- `gutenbergV2SupportPolicy` treats any block with a passing definition on the site as `fixture_required`, as it already does for `acf/` names. No block name is added to `GUTENBERG_V2_SUPPORT_MATRIX`.
- `Block_Policy::reviewed_blocks()` and `authorable_blocks()` include third-party blocks that passed. The bridge then reports them as `author_when_reviewed`, and the commit policy accepts them.
- The planner's instructions for the block are built from the stored definition (purpose, settings and children), like `acfGuidance` in `packages/services/src/gutenberg-v2-plan-generator.ts`.
- Before review, SitePilot checks the planner's settings against the definition:
  - A value outside a setting's type or allowed values goes back to the planner once to correct, and then fails, as for ACF fields.
  - Fixed settings are filled in by SitePilot, and "set by the block" settings by the block's own editor code, never by the planner.
- The block is built in the site's editor like any other, so its own code runs. The preview, approval and readback cover exactly what it produced.

### Ready-made definitions (S, optional)

- For blocks many clients use, such as Yoast's FAQ and How-to blocks or common WooCommerce blocks, SitePilot can ship a ready-made definition that fills in the review form. The block still needs its per-site test.
- When one server runs several sites, a definition reviewed on one site can be offered to another site that has the same block with the same fingerprint.

### Open questions

- **Blocks built from the rest of the post,** such as a table of contents:
  - When a later request changes the headings, should SitePilot let the block refresh itself?
  - How does that fit the rule that blocks a request doesn't touch stay byte-for-byte?
- **Settings that hold markup or rich text:** allow them, or keep them fixed at first?
- **Who can set up a block:** only site admins, as for the other diagnostics, or anyone who can publish?
- **Server-rendered blocks with no saved markup:** is the render check enough for them, or do some need more?

## Large media uploads

Media currently travels as base64 inside one signed binding request: 10 MB per file and 25 MB per request. Videos above that need:
- a chunked, resumable upload to a signed plugin route, with a checksum per chunk and for the whole file
- the same durable binding identity, so a retry never duplicates an attachment
- a higher, configurable per-file limit for videos only

Verification stays the same: checksum, container signature and served type.

## Smaller follow-ups

- **Editing posts with old-format blocks.** Allow editing a post that contains a deprecated-format block v2 can author, as long as that block stays untouched. Today the post must be resaved in WordPress first.
- **Embed previews.** Show the video's title and thumbnail in review screenshots, instead of a blank frame.
- **More core blocks:** verse, file, audio, social links.
- **Review:** a computed structural diff, alongside the stored before and after.

## Staging sites and promotion to live

Idea, logged 1 October 2026 and not yet planned. People connect a staging copy of a site alongside the live site. They create, edit and publish on staging, share it for feedback or visual sign-off, and then SitePilot replicates the change on live.

- **Linked sites.** A live site can have a staging site linked to it. Both are registered the usual way, and the link records which one is live.
- **Work happens on staging.** Requests plan, approve, apply and publish on staging, the same way they work today.
- **Share for feedback.** The staging URL of a post can go to people who don't use SitePilot, so they can comment or give visual sign-off before anything reaches live.
- **Promote to live.** After sign-off, SitePilot replays the same change on live: blocks, fields, SEO, terms and media. It goes to the matching live post, or creates one, and live gets its own approval, verification and rollback.

Open questions:
- How to match posts, media and terms between the two sites when their IDs differ.
- What to do when the live post has changed since staging was copied from it. The usual staleness check against live may be enough.
- Whether promotion replays the approved plan or copies the saved result from staging.
- Whether a staging sign-off counts as the approval for live, or live always needs its own. Either way, the approval stays in SitePilot.
- Whether reviewers record feedback and sign-off in SitePilot, for example from a review link, or only on the staging site.
- What happens when staging is refreshed from live and the links between posts on the two sites stop matching.
