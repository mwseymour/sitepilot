# Gutenberg v2 implementation

The v2 path is additive and does not fall back to SitePilot's v1 content writer. Its public TypeScript entry points are `@sitepilot/contracts`, `@sitepilot/services`, and `@sitepilot/gutenberg-worker`.

v2 is the default content engine. The WordPress plugin enables it unless the destination defines `SITEPILOT_V2_ENABLED` as the boolean `false`, which acts as a per-site off switch. The desktop app no longer has a per-site v2 setting and no longer offers the v1 planner in its UI; the v1 code paths remain in the codebase. The worker connects to WordPress; it does not start a local web server.

## Runtime construction

The runtime factory wires the signed session client, browser worker, WordPress transport, private review artifacts, staged media preview, and durable media binding without a circular source-reader setup:

```ts
import Database from "better-sqlite3";

import {
  GutenbergV2ContentService,
  FileGutenbergV2StagedAssetStore,
  SqliteGutenbergV2ApprovalStore,
  SqliteGutenbergV2ExecutionJournal
} from "@sitepilot/services";
import { createSignedGutenbergV2Runtime } from "@sitepilot/gutenberg-worker";

const database = new Database("/private/sitepilot/gutenberg-v2.sqlite");
const stagedAssets = new FileGutenbergV2StagedAssetStore(
  "/private/sitepilot/staged-media"
);
const runtime = createSignedGutenbergV2Runtime({
  siteUrl,
  siteId,
  clientId,
  sharedSecret,
  stagedAssets,
  reviewArtifactDirectory: "/private/sitepilot/review-artifacts"
});

const service = new GutenbergV2ContentService({
  worker: runtime.worker,
  wordpress: runtime.transport,
  media: runtime.media,
  journal: new SqliteGutenbergV2ExecutionJournal(database),
  approvals: new SqliteGutenbergV2ApprovalStore(database)
});
```

Use `buildLlmGutenbergV2Plan` for provider-neutral plan generation. The caller chooses `create_draft`, `replace_content`, or `apply_operations` and supplies the trusted capability and source snapshots. The generator injects post identity, source revision, content hashes, and scoped block fingerprints after model output, then parses the result through `gutenbergV2BlockPlanSchema`.

The lifecycle is `compileCandidate`, operator review, `recordApproval`, then `executeApprovedCandidate`. Approval binds the candidate bytes, semantic intent, requested fields, source state, capability fingerprint, and media manifest. SQLite journal transitions use compare-and-set semantics and resume interrupted compile, prepare, commit reconciliation, or verification work.

## Supported content

`GUTENBERG_V2_SUPPORT_MATRIX` in `packages/contracts/src/gutenberg-v2.ts` is the single list of authorable blocks and their structure rules (allowed children, required parent, required children). `npm run generate:v2-block-manifest` writes it to `plugins/wordpress-sitepilot/includes/V2/block-manifest.json`; the plugin's `Block_Policy` reads that file for its commit checks and passes it to the editor bridge, and `tests/gutenberg-v2-preservation-contracts.test.ts` fails if the file drifts.

The authoring matrix contains 27 core types: paragraph, heading, group, columns, column, image, list, list item, buttons, button, quote, spacer, table, pullquote, media-text, separator, details, code, preformatted, gallery, cover, embed, video, and accordion with its item, heading and panel. Latest Posts remains `fixture_required` and is enabled only by the site's `sitepilot_v2_reviewed_blocks` option.

ACF blocks are not in the matrix. `gutenbergV2SupportPolicy()` treats every `acf/*` name as `fixture_required`, and the plugin decides per site:

- **Discovery.** `SitePilot\V2\Acf_Blocks` describes every ACF block (block settings, `innerBlocks`, `allowedBlocks`, `usePostMeta`, default align, and every field recursively) with a `schemaHash`. Site discovery returns it as `acf_blocks`, and the editor session hands it to the bridge, which adds it to each ACF block's capability entry as `acf`.
- **Fixture.** `PlaywrightGutenbergV2Worker.runBlockFixtures()` opens a scratch page editor and calls the bridge's `blockFixture()`: it builds the block with sample values for every field (`gutenbergV2AcfSampleFields`), serializes it, reopens the markup in the editor, waits for ACF's scripts to settle, and compares bytes and field values. `POST /sitepilot/v2/block-fixtures` then repeats the checks on the server: the schema hash is current, the data matches the fields, the markup survives a real save byte-for-byte (a private scratch draft that is deleted straight after), and `render_block()` produces output with no PHP warnings. The result is stored in `sitepilot_v2_block_fixtures`, keyed by block name with its schema hash and ACF version.
- **Gate.** `Block_Policy` lists an ACF block as authorable only while its record is `passed` and matches the current schema hash and ACF version. The old `sitepilot_v2_reviewed_blocks` option cannot enable an ACF block.
- **Planning.** The planner prompt describes each authorable ACF block from its definition. The model answers with friendly `fields`; `gutenbergV2AcfDataFromFields()` converts them into ACF's stored data (`{name: value, _name: field_key}`, repeater rows as `name_0_sub`), resolving choice labels and filling defaults. Errors go back to the model in the repair round.
- **Shape.** ACF plan nodes carry `name`, `data`, `mode` and `align` (ACF's editor script sets `align` on mount, so v2 writes the block's default up front and the block reopens byte-identical).
- **Commit.** `Commit_Service` checks each authored ACF block's data against the field definitions again (`Acf_Blocks::validate_data`). An `edit_block` keeps stored field values the edit does not restate.

v1's `acf/container` handling now fills data from the live field definitions (`Acf_Blocks::normalize_data`) instead of hardcoded site defaults.

Every block object and attribute object is strict. Unknown attributes, unsupported nesting, unsafe rich text, raw wrapper markup, excessive depth or count, and destination normalization loss fail closed. Optional attributes should be omitted unless the operator requested them. In particular, button `width` is valid in the static contract. The native probe records either preservation or a structured `content_changed` result when the destination normalizes it away; the v2 planner still omits it unless a destination fixture proves preservation. Destination round-trip validation remains authoritative.

Block-specific rules:

- `core/embed` accepts only YouTube and Vimeo video URLs (`GUTENBERG_V2_EMBED_PROVIDERS`). The planner sets `providerNameSlug`, `type`, `responsive` and the 16:9 aspect classes from the URL. Before approval, the bridge asks WordPress's oEmbed proxy to resolve each new embed and fails the candidate if the video is private, deleted or wrong. The review preview does not load the provider's player, because the worker blocks third-party origins.
- `core/cover` needs child content and either a bound image (`mediaRef`) or a solid `customOverlayColor`. The bridge sets `isUserOverlayColor` like the editor does.
- `core/code` keeps line breaks as characters; `core/preformatted` stores them as `<br>`, which is WordPress's own form for that block.
- `core/video` binds an uploaded or media-library video through `mediaRef`; `autoplay` requires `muted`.
- `core/accordion` holds `core/accordion-item` blocks, and each item is exactly one `core/accordion-heading` (the toggle title) followed by one `core/accordion-panel` (any content). The bridge copies the accordion's `headingLevel`, `iconPosition` and `showIcon` onto each heading, as the editor does.

### Editing existing posts

Updates edit a working tree of the source post. The editor bridge records each block's exact byte range with the same token grammar as WordPress's default block parser. It writes every block the plan does not touch back from those bytes, and only regenerates blocks the plan authors or whose child list changes. The WordPress commit policy (`Block_Policy::find_unpreserved_block`) repeats the check on the server: every block v2 cannot author must be a byte-identical copy of a source block, used at most once.

Blocks v2 cannot author (for example core/html, classic content, reusable blocks, social links, archives, plugin blocks and blocks from inactive plugins) are reported in `SourceSnapshot.blockIndex` with `role: "preserved"`. Their contents are `inside_preserved` and cannot be targeted. A plan may keep a preserved block (`sitepilot/source-block` nodes in `replace_content` or in restated children), move it (`move_block`), or delete it on purpose (`remove_block`, or `removedSourceBlocks`). Any other outcome that would drop one fails with `content_loss`.

Scoped operations address the source snapshot the planner saw, not the tree after earlier operations. Every path, fingerprint and insertion index refers to the original tree, so an edit, an insert, a move and a removal in one plan do not invalidate each other. `edit_block` keeps the source block's attributes that the replacement does not mention (font size, colour presets, typography, metadata, classes); media attributes are rebound when the replacement names a `mediaRef`. When `replacement.children` is empty, the existing children are kept unchanged. The bridge refuses to replace a block that uses block bindings, and to remove or move a block locked against removal or moving.

Authorable blocks outside preserved regions must still pass WordPress's strict validation. As before, a post that contains an invalid or deprecated-format authorable block cannot be edited until it is resaved in WordPress.

## SEO fields

`SitePilot\Seo\Seo_Adapter` is the one mapping from neutral fields (`title`, `description`, `focusKeyphrase`, `canonical`, `indexing`, `socialTitle`, `socialDescription`) to the active SEO plugin's post meta. Only Yoast SEO is mapped (`_yoast_wpseo_title`, `_metadesc`, `_focuskw`, `_canonical`, `_meta-robots-noindex` as 0/1/2, `_opengraph-title`, `_opengraph-description`). v1 `set-post-seo-meta`, v2 commits, `get-post` and site discovery (`seo.writable`) all use it.

- **Contract.** `postFields.seo` (`gutenbergV2SeoChangesSchema`) lists only the changed fields. Values must already be what WordPress stores (`sanitize_text_field` / `esc_url_raw` leave them unchanged); the server refuses anything else rather than storing a different value than was approved. It is part of `requestedPostFields`, so `requestedFieldsHash` and the approval bind it.
- **Capability and source.** The editor session adds `seo` (plugin, version, fields) to the capability snapshot and the post's current values to the source snapshot. The planner offers SEO fields only when the capability is present.
- **Staleness.** A candidate that changes SEO on an existing post records `sourceState.affectedSeoHash` (hash of the current values), which the approval binds. `prepare` and the locked `commit` refuse the write if the post's SEO values changed. `fields_hash` is unchanged, so existing hash pairs still match.
- **Commit.** Meta is written inside the commit transaction after `wp_update_post`/`wp_insert_post`, and the resulting SEO hash must equal the prepared `serverPreparedSeoHash`. Yoast's own `save_post` indexing is not transactional; verification reads the values back afterwards.
- **Verification.** Read-back returns `seo` and `seoHash`. The worker fails verification when any requested field differs, and the content service also requires `seoHash` to match the prepared hash.
- **Rollback.** The before-state stores the exact meta rows (`seo_meta`, with `null` for absent keys). A rollback restores them only if the post's SEO values still match what was written; otherwise it returns `conflict`.

## Publish and unpublish

`set_status` is its own plan operation (`status.to`: `publish` or `draft`), so a status change never rides along with a content edit. Its plan has no blocks, operations, post fields or media.

- **Candidate.** The content service builds it without the planner or block compiler: `serializedContent` is the stored content, bound by hash, and the validation report covers every preservation dimension because the bytes are unchanged. It has no review artifacts; the desktop enables approval without previews. Allowed transitions are draft/pending → publish and publish → draft, checked in both the service and the plugin.
- **Prepare and commit.** The plugin requires the stored content byte-for-byte (no sanitizing), checks the transition again under the row lock, and requires `edit_post` plus the post type's `publish_posts` capability. The commit changes only `post_status`. For an unpublish, the prepared commit records `publishedUrl`.
- **Verification.** Read-back returns `permalink`. `SignedWordPressV2Transport.checkPublicUrl()` loads the URL with no credentials, a cache-busting query, and at most five same-origin redirects. A publish must return 2xx on the same path; an unpublish must not. A failed check triggers the normal conditional rollback, which restores the previous status only if the post still has the one this execution set. A network error keeps the execution retryable in `verifying`.
- **Desktop.** The operation picker has Publish and Unpublish. `gutenbergV2StatusIntent()` maps short follow-ups ("publish it", "take it down") in a thread that already wrote a post to a `set_status` target; anything longer stays a content request. Success is audited as `post_status_changed`. Content edits of a published post carry a "This post is live" notice.

## Media and review

Staged media is limited to JPEG, PNG, WebP and GIF images and MP4 and WebM videos. The limits are 10 MB per asset, 20 items, and 25 MB aggregate per binding request, because media travels as base64 inside the signed binding request; larger videos need a streaming upload that is not built yet. Headless browsers usually cannot decode video, so a bound video is verified by checksum, container signature and served content type, and the preview proves the approved bytes are placed in a native video element, rather than playing it. `FileGutenbergV2StagedAssetStore` writes private content-addressed files and rehashes them before preview and binding.

Before approval, staged bytes render through an in-memory `data:` preview mapping and never enter the WordPress media library. Existing library attachments resolve through the signed read-only branch of the media-bindings route, keep their attachment ID, and are fetched from the configured WordPress origin without redirects before checksum verification. Existing attachment alt text and captions are never mutated; block intent owns those values.

A media caption must be represented by an explicit `core/image` block using the same media ref. `core/media-text` has no native caption attribute, so a caption attached only to a media-text ref is rejected during contract parsing.

After approval, `DurableGutenbergV2MediaService` sends stable per-item binding identities to the signed media-bindings route. WordPress journals normalized intent before file or attachment creation and reconciles interrupted items on retry. The final compiler and verifier require the same approved checksum, attachment identity, final URL, and successful image load.

Review artifacts are private immutable files. They contain source evidence and an explicit before/after structure for updates, the final serialized candidate, and desktop and mobile screenshots. Screenshot filenames include their byte hash, so a nondeterministic rerender cannot collide with an earlier immutable artifact.

The screenshot worker measures the rendered title and block bounds inside the native editor iframe, disables WordPress canvas transitions during capture, and expands the canvas without changing its settled width. It rejects inaccessible, unstable, clipped, oversized, or dimension-mismatched output. Surrounding editor chrome is hidden only while the canvas is captured and all temporary styles are restored afterward.

## Verification

Run focused TypeScript checks with:

```sh
nvm use 22.22.3
npx tsc -b packages/contracts packages/services packages/plugin-protocol packages/gutenberg-worker --pretty false
npx vitest run tests/gutenberg-v2-contracts.test.ts tests/gutenberg-v2-preservation-contracts.test.ts tests/gutenberg-v2-service.test.ts tests/gutenberg-worker.test.ts
```

Changes to this path also require the repository content E2E suite:

```sh
nvm use 22.22.3
npm run test:e2e:content
```

The release gate runs the legacy suite and the explicitly enabled v2 native harness:

```sh
nvm use 22.22.3
npm run test:e2e:all
npm run test:e2e:v2
npm run test:e2e:v2-chat
```

The E2E harness exercises whatever plugin copy the MAMP site has installed, not this repository's `plugins/wordpress-sitepilot` directly. Sync the plugin into the site before running the WordPress suites after plugin changes.

While developing one scenario, `SITEPILOT_V2_E2E_ONLY=preservation` or `SITEPILOT_V2_E2E_ONLY=new-blocks` runs only that part of `tests/e2e/v2-gutenberg.ts`; the release gate always runs it in full.

`test:e2e:v2-chat` exercises the real desktop chat boundary against the configured
MAMP destination. It uses a temporary desktop database and deterministic planner,
then prints only a redacted artifact summary and the created draft post ID for
manual cleanup. Run it only while the managed MAMP site is available; it does not
start services, change ports, or modify the WordPress plugin.

## Verification evidence

The 22 September 2026 validation run established the following evidence:

The measured local profile was MAMP with WordPress 7.1.1, PHP 8.2.30, Twenty Twenty-Five 1.0, and InnoDB-backed `posts`, `postmeta`, and `options` tables. Discovery reported 273 registered blocks; the v2 authoring matrix enabled 15 reviewed core block types. This profile records the tested destination and does not establish destination-wide production compatibility.

- All 224 repository unit tests passed under Node 22.22.3.
- The contracts, services, protocol, and Gutenberg worker TypeScript project references passed, as did Prettier and the focused v2 lint checks.
- All 30 focused Gutenberg v2 contract, service, and worker tests passed.
- The final Node 22 legacy E2E rerun passed all six WordPress scenarios against MAMP.
- Ten new WordPress v2 PHP tests passed. The four pre-existing v1 write-ability failures were fixed on 25 September 2026; the full plugin PHPUnit suite (47 tests) now passes.
- The complete native v2 harness passed strict compilation, staged and existing-library media preview and binding, persisted draft creation, exact readback, and normal Gutenberg save/reopen with all blocks valid.
- The full mixed fixture covers 15 block types across 21 nodes and produced an inspected 1160 x 1712 desktop review image and a 390 x 1672 mobile review image. Both include the pullquote, primary image and caption, media-text image, and media-text body without surrounding editor UI obscuring the content.
- The native scope and failure gates passed: staged media identities were reused on retry, scoped-update authorization and four negative controls rejected unsafe changes, and destination attribute normalization was detected.
- The uncertain-response path reconciled a lost commit response to the same post and succeeded. Stale commits were rejected, concurrent human edits prevented rollback and were preserved, and an uncontended scoped rollback restored the exact source.

The final native evidence is recorded in `.sitepilot-test-artifacts/v2-gutenberg-2026-09-22T11-47-05.401Z/summary.json`.

After validation, the local MU test flag was removed with a hash guard. The live protocol then reported `v2.enabled=false` with bridge version `2.0.0-alpha.1`; MAMP was left running for follow-up checks. Production remains gated on destination-specific native editor and persistence fixtures plus explicit boolean enablement.

As of 25 September 2026 the desktop typecheck (`npm run typecheck` in `apps/desktop`) and full desktop build complete without errors.

### 25 September 2026: preservation and new blocks

Against the same MAMP profile, with the plugin synced from this repository and Node 22.22.3:

- `npm run test:e2e:v2` passed. Its preservation scenario applied an edit, an insert, a move and a removal in one plan. core/html, core/archives, social links, an inactive plugin block and an untouched paragraph all stayed byte-identical, and the edited paragraph kept its font size. The scenario also rejected an edit inside a preserved block and two replacements that would drop blocks (`locked_structure`, `content_loss`), and a replacement that kept chosen blocks succeeded.
- The new-blocks scenario created cover (image and colour), separator, details, code, preformatted, gallery, YouTube embed and uploaded MP4 video blocks (14 nodes). A normal editor save and reopen found all 14 valid and left the bytes unchanged. A scoped code edit kept its line breaks, and an unavailable YouTube URL was rejected before approval.
- `npm run test:e2e:all` passed all six legacy scenarios. `npm run test:e2e:v2-chat` passed.
- 306 unit tests and 52 plugin PHPUnit tests passed.
