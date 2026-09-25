# v2 roadmap

Status: planned, 25 September 2026. This is the forward-looking list for the Gutenberg v2 content engine and the clients that use it.
- For what v2 does today, see [What Gutenberg v2 can do](./v2-capabilities.md).
- Detailed plans for the SEO, publishing and target-resolution phases stay in the [v2 expansion plan](./v2-expansion-plan.md), along with what Phases 0 to 2 (safe editing, new core blocks, ACF blocks) delivered.
- The hosted architecture, including the SitePilot MCP server that Slack, Claude and Codex share, is in [v2 build](./v2-build.md#91-sitepilot-mcp-server).

## Overview

| Item | Plan | Size |
| --- | --- | --- |
| ACF follow-ups: attached media for image and file fields, `usePostMeta` storage, more field types | [Below](#acf-follow-ups) | M |
| SEO fields (Yoast first) | [Expansion plan, Phase 3](./v2-expansion-plan.md#phase-3-seo-fields) | M |
| Publish, unpublish and schedule | [Expansion plan, Phase 4](./v2-expansion-plan.md#phase-4-publish-and-unpublish) | M |
| Choosing a request's post from the message | [Expansion plan, Phase 5](./v2-expansion-plan.md#phase-5-resolving-a-requests-target-from-text-sm) | S–M |
| Categories and tags | [Below](#categories-and-tags) | M |
| Lookup registry and extensible conversations | [Below](#lookup-registry-and-extensible-conversations) | M–L |
| SitePilot MCP server (Slack, Claude, Codex) | [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server) and [below](#mcp-server) | L |
| Streaming upload for videos over 10 MB | [Below](#large-media-uploads) | M |

**Shared prerequisite.** SEO fields, and categories and tags, both need non-string post fields. Today `requestedPostFields()` in `packages/services/src/gutenberg-v2-content-service.ts` keeps string values only. They also need a staleness hash separate from `fields_hash`. Do that contract work once, for both.

**Suggested order:**
1. The lookup registry. It unblocks the MCP server, and every later phase adds lookups to it.
2. Categories and tags together with SEO, since they share a prerequisite.
3. Publishing and target resolution.
4. The MCP server, then the Slack app as its client.
5. ACF follow-ups and large media uploads, as sites need them.

## Categories and tags

Neither v1 nor v2 can set taxonomy terms today. The only uses of a category are as a lookup filter (`find-posts`), and in discovery, which records which public taxonomies exist but not their terms.

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

The design is in [v2 build, 9.1](./v2-build.md#91-sitepilot-mcp-server). The Slack app is built as a client of the server, and Claude and Codex connect to the same server. Order of work:

1. The lookup registry above, exposed as the read tools.
2. OAuth 2.1, mapping users to roles, scopes, audit and rate limits.
3. `create_request`, `add_to_request` and `request_status`, on the existing `ingestThreadMessage` entry point.
4. The review page and approval links. No tool can approve.
5. The Slack app as an MCP client: slash commands, a thread-to-request mapping, and approval buttons.
6. `submit_block_plan`, only after the organisation's LLM policy allows client-side planning.

## ACF follow-ups

ACF blocks are discovered, authored from the site's field definitions, and enabled per site after a save-and-reopen fixture passes (expansion plan, Phase 2). Still open:

- **Attached media for ACF image and file fields.** Today these fields take existing media-library IDs only. The fix is to bind them through `mediaRef` like core images: upload after approval, then checksum-verify.
- **`usePostMeta` storage.** Blocks that keep their fields in post meta stay kept-only. Writing them needs the post-meta path from the shared prerequisite above.
- **More field types.** A block with a required gallery, user, Google Map or similar field stays kept-only until that field type has a reviewed shape.
- **Other third-party blocks.** Plugin blocks other than ACF blocks are kept safely but cannot be authored. The same per-site fixture approach would apply.

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
