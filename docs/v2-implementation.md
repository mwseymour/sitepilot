# Gutenberg v2 implementation

The v2 path is additive and does not fall back to SitePilot's v1 content writer. Its public TypeScript entry points are `@sitepilot/contracts`, `@sitepilot/services`, and `@sitepilot/gutenberg-worker`.

The WordPress plugin keeps v2 disabled unless the destination explicitly defines `SITEPILOT_V2_ENABLED` as the boolean `true`. Enable it only on a destination that has passed the native editor and persistence fixtures. The worker connects to WordPress; it does not start a local web server.

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

The initial authoring matrix contains paragraph, heading, group, columns, column, image, list, list item, buttons, button, quote, spacer, table, pullquote, and media-text. Latest Posts and ACF Container remain fixture-gated and are authorable only when discovery reports `author_when_reviewed` for the destination.

Every block object and attribute object is strict. Unknown attributes, unsupported nesting, unsafe rich text, raw wrapper markup, excessive depth or count, and destination normalization loss fail closed. Optional attributes should be omitted unless the operator requested them. In particular, button `width` is valid in the static contract but is omitted by the v2 planner because the release WordPress runtime can normalize it away. Destination round-trip validation remains authoritative.

Scoped update planning uses `SourceSnapshot.blockIndex`, whose entries contain native editor paths and fingerprints. The generator accepts model-selected paths but replaces every model fingerprint with the trusted source index value.

## Media and review

Raster media is limited to JPEG, PNG, WebP, and GIF. The limits are 10 MB per asset, 20 items, and 25 MB aggregate per binding request. `FileGutenbergV2StagedAssetStore` writes private content-addressed files and rehashes them before preview and binding.

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
npx vitest run tests/gutenberg-v2-contracts.test.ts tests/gutenberg-v2-service.test.ts tests/gutenberg-worker.test.ts
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
```

## Verification evidence

The 22 September 2026 validation run established the following evidence:

The measured local profile was MAMP with WordPress 7.1.1, PHP 8.2.30, Twenty Twenty-Five 1.0, and InnoDB-backed `posts`, `postmeta`, and `options` tables. Discovery reported 273 registered blocks; the v2 authoring matrix enabled 15 reviewed core block types. This profile records the tested destination and does not establish destination-wide production compatibility.

- All 224 repository unit tests passed under Node 22.22.3.
- The contracts, services, protocol, and Gutenberg worker TypeScript project references passed, as did Prettier and the focused v2 lint checks.
- All 30 focused Gutenberg v2 contract, service, and worker tests passed.
- The final Node 22 legacy E2E rerun passed all six WordPress scenarios against MAMP.
- Ten new WordPress v2 PHP tests passed. Four unrelated PHP baseline failures remain in the pre-existing suite.
- The complete native v2 harness passed strict compilation, staged and existing-library media preview and binding, persisted draft creation, exact readback, and normal Gutenberg save/reopen with all blocks valid.
- The full mixed fixture covers 15 block types across 21 nodes and produced an inspected 1160 x 1712 desktop review image and a 390 x 1672 mobile review image. Both include the pullquote, primary image and caption, media-text image, and media-text body without surrounding editor UI obscuring the content.
- The native scope and failure gates passed: staged media identities were reused on retry, scoped-update authorization and four negative controls rejected unsafe changes, and destination attribute normalization was detected.
- The uncertain-response path reconciled a lost commit response to the same post and succeeded. Stale commits were rejected, concurrent human edits prevented rollback and were preserved, and an uncontended scoped rollback restored the exact source.

The final native evidence is recorded in `.sitepilot-test-artifacts/v2-gutenberg-2026-09-22T11-47-05.401Z/summary.json`.

After validation, the local MU test flag was removed with a hash guard. The live protocol then reported `v2.enabled=false` with bridge version `2.0.0-alpha.1`; MAMP was left running for follow-up checks. Production remains gated on destination-specific native editor and persistence fixtures plus explicit boolean enablement.

The full desktop build currently reports six renderer errors that reproduce unchanged from clean `HEAD`; they are outside the additive v2 implementation.
