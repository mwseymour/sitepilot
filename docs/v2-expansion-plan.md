# Gutenberg v2 expansion plan

Status: Phases 0 to 3 implemented on 25 September 2026; Phases 4 and 5 proposed. The [v2 roadmap](./v2-roadmap.md) is the overall list of planned work, including categories and tags, the lookup registry and the MCP server. Scope is the local desktop app and the WordPress plugin. Hosted, Slack and Copilot work is out of scope.

## Delivered on 25 September 2026

- **0.1:** `GUTENBERG_V2_SUPPORT_MATRIX` now carries the structure rules. `npm run generate:v2-block-manifest` writes `includes/V2/block-manifest.json`, which PHP (`Block_Policy`) and the bridge both read. A unit test fails on drift.
- **0.2 and 0.3:** blocks v2 cannot author are kept byte-for-byte and reported as `preserved`. Any change that would drop one without an explicit removal fails with `content_loss`. The server checks byte-identity again at commit.
  - One difference from the plan: blocks from inactive plugins (`core/missing`) and invalid preserved blocks are kept rather than rejected. Keeping them untouched is safer than refusing the edit.
- **0.4:** scoped operations resolve against the original snapshot, so several operations work in one plan. `move_block` exists, and review shows a "Deleted on purpose" list.
  - One difference: the review artifact still stores the source and the new content. It does not store a computed structural diff.
- **0.5:** `edit_block` keeps unmentioned attributes and existing children.
- **0.6:** fixture-gated blocks can report `author_when_reviewed`, driven by the `sitepilot_v2_reviewed_blocks` option. The edit ancestor-list bug is fixed.
  - The target `ref` check was dropped. Fingerprints already prove identity, and no mechanical check can prove the model chose the right block.
- **Phase 1:** separator, details, code, preformatted, gallery, cover, YouTube/Vimeo embeds and video are authorable.
  - Video supports media-library files and uploaded MP4/WebM up to the existing 10 MB per-file limit.
  - A streaming upload for larger videos is **not** built.
  - Verse and footnotes were not added.
- **Phase 2 (ACF):** every ACF block is discovered with all its fields and a schema hash, authored from the site's own field definitions, and enabled per site only after a recorded save-and-reopen fixture passes (Diagnostics → Test ACF blocks). Unpassed, failed or stale blocks stay preserved. v1's hardcoded container defaults are gone. Verified on the playground site: all nine of its ACF blocks pass, and a Container page was created from a plain request and edited in place.
  - Differences from the plan: the server-rendered check uses `render_block()` inside the fixture request rather than `/wp/v2/block-renderer`. Fixtures are keyed by schema hash and ACF version (the SitePilot version is recorded, not compared). Image and file fields take existing library IDs; `mediaRef` binding for ACF fields and `usePostMeta` storage are **not** built.
  - Found while testing: ACF's editor script adds `"align":""` to every ACF block when it mounts, so v2 now writes the default align itself. And on sites where WordPress drops the editor iframe (any apiVersion 2 block, as ACF blocks are), the review capture measured a height that grew with every attempt; it now measures the blocks themselves.
- **Phase 3 (SEO, Yoast):** a shared `Seo_Adapter` maps seven neutral fields to Yoast meta for v1, v2, `get-post` and discovery. `postFields.seo` is approval-bound, stale-checked with a separate `affectedSeoHash`, written in the commit transaction, verified on read-back, and restored exactly on rollback. SEO-only edits use a fields-only `apply_operations`. Verified against Yoast 27.4 on the MAMP site (`npm run test:e2e:v2-seo`), including a stale refusal, a restore and a rollback conflict.
  - Not built: the Open Graph image (it needs media binding), and RankMath/AIOSEO mappings.

## Goals

1. Author more core blocks: video (uploaded and YouTube), gallery, cover, separator and similar.
2. Author third-party blocks, starting with ACF blocks.
3. Update SEO fields for the SEO plugin found during discovery (Yoast first).
4. Publish and unpublish from the request chat. New content is still always created as a draft.
5. Edit existing posts safely. A remove plus insert, or a move, must never lose content or structure.
6. Let a request find its target from the message text, for example "update the last created post".

## Where v2 is today (verified 25 September 2026)

- **Block list is copied by hand in four places:** `GUTENBERG_V2_SUPPORT_MATRIX` (`packages/contracts/src/gutenberg-v2.ts:24`), `AUTHOR_BLOCKS` in `plugins/wordpress-sitepilot/assets/js/editor-bridge.js:6`, and two PHP lists in `includes/V2/Commit_Service.php:707` and `:763`. Adding one block with no media takes about 10 edits across 5 files.
- **Existing posts containing any block outside the 15 authorable types cannot be edited with `apply_operations`.** `validateExistingTree` (`editor-bridge.js:624`) rejects the whole post, including cover, embed, ACF, reusable and HTML blocks.
- **`replace_content` silently drops blocks it cannot author.** The new tree is built only from `plan.blocks` (`editor-bridge.js:1177`). Nothing checks what was removed. This is a content-loss risk today.
- **`edit_block` rebuilds the block from the strict schema.** Attributes the schema doesn't know (`fontSize`, colour presets, `style.typography`, `metadata`) are dropped, and all children are replaced by what the model restates.
- **Several operations in one plan usually fail with `stale_source`.** All fingerprints come from the original snapshot and are never recomputed as operations apply. This is safe, but remove plus insert is impractical in practice.
- **There is no move operation.** Only insert, edit and remove exist.
- **`fixture_required` blocks can never be enabled.** `supportMode()` (`editor-bridge.js:99`) never returns `author_when_reviewed`, and `preserve_only` exists in the contract but is never produced.
- **Media is raster images only**, end to end: contracts, staging, worker load check, bridge preview, PHP type check and desktop attachment decoding.
- **The worker blocks all third-party origins**, so a YouTube iframe would render empty in preview.
- **Discovery captures only ACF choice fields** (select, radio, button group, checkbox, true/false). It detects Yoast, RankMath and AIOSEO by plugin file name, but the desktop only acts on Yoast. The v2 planner receives no discovery or ACF data at all.
- **SEO:** v1 has `sitepilot/set-post-seo-meta` (Yoast title and description only). v2 has no post meta support. Its post fields are title, excerpt and featured image only.
- **Status:** draft is hardcoded in five places. No publish, unpublish or schedule ability exists in v1 or v2. When editing an existing post, v2 keeps its status, so an approved edit to a published post goes live directly.
- **Targets:** the v2 target is always chosen in the UI (operation, post type, post ID). The only automatic resolution is "the post this thread already wrote".

## Phase 0: Foundations (do first; later phases depend on it)

Content safety and the per-block cost both need fixing before adding blocks, or every new block multiplies the problem.

### 0.1 One source of truth for the block list (S)

- Generate a JSON manifest from `GUTENBERG_V2_SUPPORT_MATRIX` at build time.
- The PHP plugin reads the manifest for both allowlists. The editor session config passes it to the bridge, so the bridge no longer hardcodes the lists.
- Add a unit test that fails if any layer disagrees.
- Result: a new block means one matrix entry, a schema, planner guidance, bridge build logic and fixtures.

### 0.2 Preserve-only blocks (M)

- Existing blocks the engine can't author are carried through untouched: cover, embed, ACF, reusable (`core/block`), `core/html`, and anything not yet reviewed.
- The planner sees them as opaque, labelled nodes with their path, fingerprint and a short text summary. It can insert blocks before or after them, remove them, or move them. It cannot edit inside them.
- On output, a preserved block is emitted **byte-for-byte from its original source slice**, not re-serialized. The verifier checks each preserved block's bytes against the source.
- The bridge reports `preserve_only` for registered blocks outside the authoring matrix. Posts that contain `core/missing` (unregistered) or invalid blocks are still rejected.
- Result: posts with covers, embeds or ACF blocks can be edited around those blocks.

### 0.3 Content-loss guards (S)

- `replace_content` fails with a new `content_loss` code if any source block, or source text, disappears without being declared. The plan must list intended removals (by path and fingerprint), and review shows them explicitly as "Removed: …".
- The same check applies to `apply_operations`. Text removed from the post must be accounted for by a `remove_block` or `edit_block` operation.
- Untouched blocks must keep their original bytes. This replaces today's semantic-only check.

### 0.4 Reliable multi-operation plans, and move (M)

- Recompute paths and fingerprints after each operation is applied (or apply operations against stable node IDs instead of paths), so remove plus insert in one plan works.
- Add a `move_block` operation that moves the original parsed block, including preserved blocks, without re-authoring it. Prefer it over remove plus insert for reordering. Remove plus insert stays valid, as you agreed, since WordPress keeps revisions.
- Record the source structure at the start of every candidate, including block tree, attributes and byte slices. Record the result at the end. Put both in the review artifact as a real structural diff; today `structureDiffRef` stores both versions but no computed diff.

### 0.5 Keep attributes on `edit_block` (S)

- Merge the source block's attributes that the model didn't mention (styles, font size, colour presets, `metadata`, `className`, anchor) into the rebuilt block, instead of dropping them.
- Keep children unless the operation explicitly replaces them.
- Where an attribute can't be kept, for example because it's invalid for the new variant, fail with a clear message rather than silently dropping it.

### 0.6 Bridge fixes (S)

- `supportMode()` must be able to return `author_when_reviewed` when a per-site fixture record exists. This unlocks Phase 2.
- Fix the ancestor list on `edit_block`: `editor-bridge.js:872` uses `ancestors.slice(0, -1)`, but inserts include the parent.
- Check the optional target `ref` against the source index, so a model that returns the wrong path is caught.

**Exit gate:**
- New E2E fixtures edit a post containing cover, embed and ACF blocks. The preserved blocks come back byte-identical.
- A remove plus insert of the same content round-trips.
- A `replace_content` that would drop a preserved block is rejected.

## Phase 1: More core blocks

Blocks ship in batches. Each block's definition of done:

- Matrix entry and strict schema.
- Planner guidance.
- Bridge build (`createBlock`) and media mapping, if the block uses media.
- A node in the native save/reopen E2E fixture (`tests/e2e/v2-gutenberg.ts`).
- Contract tests.
- A review outline label.

**Batch A: static, no media (S each)**
- `core/separator` (styles: default, wide, dots).
- `core/details`.
- `core/code`.
- `core/preformatted`.
- Optionally `core/verse`, `core/footnotes` (skip footnotes unless needed; it relies on post meta).

**Batch B: image-based (M)**
- `core/gallery`: children are `core/image` blocks, so it reuses image binding. Covers columns, crop and link settings, and the gallery caption.
- `core/cover`: an image background through `mediaRef` (featured-image background optional), or a colour/gradient-only cover, plus overlay colour/opacity, min height and inner blocks. Needs a new `applyMediaMapping` branch (`id`, `url`, `backgroundType: "image"`).

**Batch C: YouTube and other embeds (M)**
- `core/embed` with a **provider allowlist**, starting with YouTube, Vimeo and optionally Spotify. Validate the URL shape per provider.
- The planner cannot fill embed attributes reliably, so the bridge sets them deterministically: `providerNameSlug`, `type: "video"`, `responsive: true`, and the aspect-ratio `className` (for example `wp-embed-aspect-16-9 wp-has-aspect-ratio`).
- **Preview:** add the allowlisted provider origins to the worker's origin allowlist, or render a labelled placeholder showing the video URL, so the screenshot isn't blank.
- **Verification:** the WordPress oEmbed proxy (`/wp-json/oembed/1.0/proxy`) must resolve the URL before commit. This catches private or deleted videos.

**Batch D: uploaded video (L)**
- Start with library videos: `core/video` pointing to an existing attachment. This avoids the upload pipeline.
- Then uploaded MP4/WebM:
  - Add a media kind to the contract (`image | video`).
  - Detect MP4/WebM from file signatures.
  - Move staging off base64 JSON, since 10 MB per item is far too small for video.
  - Add a video load check in the worker and preview (`loadedmetadata`) and a `core/video` branch in media mapping.
  - Support an optional poster image.
  - Check that `<video>` survives kses for the authoring user.
- The desktop attachment pipeline currently re-encodes non-PDF files to JPEG. It needs a separate video path.

**Later candidates:** `core/file`, `core/audio`, `core/social-links`, `core/navigation` (probably never, since it's site-level), `core/query` and `core/latest-posts` (dynamic, fixture per site).

## Phase 2: ACF blocks

Goal: any ACF block on the site can be authored once a per-site fixture has proved it. Until then it is preserved (Phase 0.2), never dropped.

### 2.1 Discovery (M)

- Capture every `acf/*` block with:
  - Its block.json metadata: `supports`, `mode`, allowed inner blocks, and ACF 6.3's `usePostMeta` storage flag.
  - **Every field**: text, textarea, WYSIWYG, number, URL, email, select, radio, checkbox, true/false, image, file, link, repeater, group and flexible content. Include keys, names, required flags, defaults, choices, and conditional logic where practical.
  - A schema hash, so a change to the field group makes existing fixtures stale.
- Pass this to the v2 planner as destination-specific block definitions. Today the v2 planner receives no discovery data at all.

### 2.2 Authoring (M–L)

- Build a strict schema for each block at runtime from the discovered fields, instead of the loose `data: record` used today.
- Values are written in ACF's block shape: `data: { field_name: value, _field_name: field_key }`.
- Choice values are resolved to real choices using the v1 helpers (`acf_field_choice_value`, `normalize_choice_token`), moved into a shared PHP helper and called during PHP prepare.
- **Remove the site-specific hardcoded defaults in v1 `acf_container_attrs`** (`Write_Abilities.php:656-669`: `bg-white`, padding classes, bottom border). Defaults come from the field definitions instead.
- Image and file fields bind through `mediaRef` to an attachment ID, like `core/image`.
- InnerBlocks-capable ACF blocks accept children according to their allowed-blocks list.
- Blocks with `usePostMeta` storage write post meta, which follows the SEO meta path in Phase 3. Support this second, unless your site uses it.

### 2.3 Enabling a block per site (S)

- A block is enabled by recording a passing fixture: native save and reopen, valid, with attributes preserved.
- The server-rendered output is also checked through `/wp/v2/block-renderer/acf/<name>`: non-empty, and no PHP warnings or errors.
- The fixture record is stored per site, keyed by block name, schema hash and plugin version. The bridge then reports `author_when_reviewed` (Phase 0.6).
- Changing the field group or the ACF version turns the block back to preserve-only until the fixture is re-run.

**What I need from you before you test:** the list of ACF blocks you want first, their field groups (an export is fine), and one sample post that uses them.

## Phase 3: SEO fields

### 3.1 Discovery (S)

- Detect the active SEO plugin and its version (Yoast, RankMath, AIOSEO) and store it in the site config. Today only Yoast is acted on.
- Record which fields the adapter supports for that plugin.

### 3.2 PHP SEO adapter (S)

- One shared helper, used by both the v1 `set-post-seo-meta` ability and v2, mapping neutral fields to plugin meta keys.
- **Yoast first:**
  - `_yoast_wpseo_title`
  - `_yoast_wpseo_metadesc`
  - `_yoast_wpseo_focuskw`
  - `_yoast_wpseo_canonical`
  - `_yoast_wpseo_meta-robots-noindex`
  - `_yoast_wpseo_opengraph-title`, `-description` and `-image`
- Keep Yoast variables such as `%%title%%` as they are.
- RankMath and AIOSEO mappings follow the same interface later.

### 3.3 v2 contract and commit (M)

- Add `postFields.seo` (an object). The approval binds it automatically through `requestedFieldsHash`. Fix `requestedPostFields()` (`gutenberg-v2-content-service.ts:260`), which currently drops non-string values.
- Add the new object key to `Runtime_Fingerprint::sort_value` (`Runtime_Fingerprint.php:97`), so PHP and TypeScript hash identically.
- Add a separate `affectedMetaHash` to the staleness checks, rather than changing `fields_hash`, which would break the existing hash pairs.
- Include before-state meta in rollback, and verify it on readback.
- Write meta inside the commit, after `wp_update_post`. Note that Yoast re-indexes on `save_post`: its hooks are not transactional, so verification reads the values back afterwards.
- SEO-only changes use a fields-only `apply_operations`, which is already allowed.
- Read side: add SEO fields to `get-post`, so Conversations can answer "what's the meta description on post 946?".

## Phase 4: Publish and unpublish

Everything is still created as a draft. Publishing is a separate, explicitly approved step.

### 4.1 Status operation (M)

- Add a dedicated `set_status` operation rather than a post field, so a status change can never ride along silently with a content edit. Transitions:
  - Publish (`draft/pending → publish`).
  - Unpublish (`publish → draft`; `private` as an option).
  - Schedule (`→ future`, with a date).
- A status-only candidate skips block compilation. It binds the source content hash and fields hash, with content unchanged. The PHP check currently requires `validation.outcome === "valid"`, so it needs a status-only path.
- Permissions: `publish_posts` or `publish_pages` (the post type's publish capability), not only `edit_post`.
- Verification:
  - Read back the status.
  - For publish, check the permalink returns 200 publicly.
  - For unpublish, check it no longer does.
- Add a `post_status_changed` audit event. Rollback restores the previous status only if the post still has the status this execution set.

### 4.2 Chat (S–M)

- In a request thread, "publish it", "publish post 946", "unpublish" and "schedule for Friday 9am" produce a status candidate for the thread's post, or for a resolved target (Phase 5).
- The approval card states plainly what happens. For example: "Publish #946 'Title' → it will be live at https://…/slug/".
- **Decision needed:** editing an already-published post currently goes live on approval. Options:
  - (a) Keep that; revisions exist.
  - (b) Stage edits to live posts as a pending revision until "publish changes". Recommendation: (a) for now, with the approval card warning "This post is live".

## Phase 5: Resolving a request's target from text (S–M)

- Before binding a request's target, resolve the post from the message:
  - "post 946" or an editor URL.
  - "the post titled …".
  - "the last created post" (`find-posts` with `orderby=date&order=DESC&limit=1`, which now works).
  - "the latest page".
- Reuse `packages/services/src/post-target-resolution.ts` (currently used only by v1).
- Binding is safety-critical, so the resolved post is shown back for confirmation before generating. For example: "I'll update #946 'Back button hijacking…' (draft) — continue?". Ambiguous matches list the candidates instead of guessing.
- The UI's Post ID field stays as an override. Slack will need exactly this.
- Conversations already handle "last created post" (25 September fix) once the site runs the updated plugin.

## Suggested order and rough size

| Order | Work | Size |
| ----- | ---- | ---- |
| 1 | Phase 0.3 content-loss guard for `replace_content` (quick win, closes today's risk) | S |
| 2 | Phase 0.1 single block manifest, 0.6 bridge fixes | S |
| 3 | Phase 0.2 preserve-only blocks, 0.4 multi-op and move, 0.5 attribute keeping | M–L |
| 4 | Phase 1 batch A, then B | S, then M |
| 5 | Phase 4 publish/unpublish + Phase 5 target resolution | M |
| 6 | Phase 3 SEO (Yoast) | M |
| 7 | Phase 2 ACF (discovery, then authoring, then per-site enablement), ready for your testing | M–L |
| 8 | Phase 1 batch C (YouTube), then D (uploaded video) | M, then L |

ACF can start earlier if your test window is soon. Its discovery work (2.1) doesn't depend on Phase 0; only authoring does.

## Testing gates

- Every phase: unit tests, `plugins/wordpress-sitepilot` PHPUnit, and the suite `AGENTS.md` requires. These changes span planning, execution, contracts and plugin writes, so that means `npm run test:e2e:all`, plus `npm run test:e2e:v2` and `npm run test:e2e:v2-chat` against MAMP.
- New fixtures:
  - A post containing cover, embed and ACF blocks, edited around those blocks, with byte-identical preservation.
  - A remove plus insert round-trip.
  - A `replace_content` loss rejection.
  - Each new block's save/reopen node.
  - A YouTube oEmbed resolve.
  - A per-site ACF block fixture.
  - Yoast meta readback.
  - Publish → public 200, then unpublish → not public.

## Open questions

1. Which ACF blocks and field types come first, and does the site use ACF post-meta storage for any of them?
2. Which SEO fields do you need beyond title and description (focus keyword, canonical, noindex, social)?
3. Video: YouTube embeds only to start, or uploaded MP4 as well? Uploads are the largest single item.
4. Should unpublish go to `draft` or `private`? Is scheduling needed in the first cut?
5. Edits to live posts: keep "approve = live" (recommended for now), or stage as pending changes?
