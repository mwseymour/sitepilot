# SitePilot WordPress plugin

Companion plugin for the SitePilot desktop app: protocol metadata REST routes, `wordpress/mcp-adapter` integration with read-only lookup tools, and the signed Gutenberg v2 routes that make every content change.

The MCP tools only read: `find-posts`, `get-post`, `site-discovery` and `ping`. Content changes go through the v2 routes described below, after someone approves them in SitePilot.

## Changes

- **0.2.0:**
  - Removed the v1 write abilities (`create-draft-post`, `update-post-fields`, `set-post-seo-meta`, `set-post-featured-image` and `upload-media-asset`) and the unused `site-summary` ability. SitePilot no longer calls them. Update every site, because older versions still expose them.
  - A registration code works once. A new one appears on Settings → SitePilot after each registration, behind "Show code", with a Reset button.
  - Registering never replaces an existing site ID, and needs the WordPress username SitePilot acts as. Signed calls get exactly that user's capabilities, with no fallback to an administrator.
  - The plugin MCP route only accepts SitePilot-signed requests; a browser login or application password isn't enough.
  - Lookups only return drafts, pending and private posts to users who can edit them.
  - Request nonces are recorded atomically, so parallel replays can't both pass.
  - Settings → SitePilot lists registered clients, with a Revoke button.
  - `/protocol` lists the plugin's `features`, so the desktop only uses what the site supports.
  - Errors follow `sitepilot.error/v1` (`error_contract_v1`). Each one has a stable code, a cause and whether retrying could help. A refused signed request also says why (`auth.reason`), and `/sitepilot/v1/echo-headers` shows which signing headers reached the site.
  - `/sitepilot/v2/render-check` (`render_check_v1`) renders a saved post in-process, so SitePilot can roll back an edit that breaks the page.
  - Signed approvals (`approval_proof_v1`). A client can register an Ed25519 approval key through `/sitepilot/v2/approval-key`. From then on, every v2 write from that client needs an approval signed with that key. The approval must be bound to the exact change, last at most 30 minutes and be used once. Commit receipts record who approved each write.
  - A media upload whose file type check fails leaves no file behind.

## Requirements

- WordPress **6.9+** (Abilities API in core)
- PHP **8.1+**
- [Composer](https://getcomposer.org/) to install PHP dependencies

## Install (development)

```sh
cd plugins/wordpress-sitepilot
composer install
```

Then symlink or copy this folder into `wp-content/plugins/sitepilot` and activate **SitePilot** in wp-admin.

## Endpoints

| Purpose              | Method | Route                            |
| -------------------- | ------ | -------------------------------- |
| Health               | GET    | `/wp-json/sitepilot/v1/health`   |
| Protocol metadata    | GET    | `/wp-json/sitepilot/v1/protocol` |
| Signing header check | GET, POST | `/wp-json/sitepilot/v1/echo-headers` |
| MCP (HTTP, JSON-RPC) | POST   | `/wp-json/sitepilot/mcp`         |

MCP calls must be signed by a registered SitePilot client, and run as the WordPress user it was registered with. After `initialize`, send the `Mcp-Session-Id` header on subsequent JSON-RPC requests (handled automatically by `@sitepilot/mcp-client`).

If the SitePilot MCP server doesn't register (no Abilities API, no MCP Adapter, a different MCP Adapter loaded first, or the adapter rejecting the server), the plugin records why. Settings → SitePilot shows the reason and the loaded adapter version, the Dashboard and Plugins screens show an admin notice, and the PHP error log gets one line when the state changes. `/protocol` reports `mcp.registered` and `mcp.issue` for that request, without the detail message.

## Composer packages

- [`wordpress/mcp-adapter`](https://packagist.org/packages/wordpress/mcp-adapter) — official WordPress MCP bridge (HTTP transport).

Vendor directory is gitignored; run `composer install` after clone.

## Gutenberg v2 content engine

The v2 editor bridge and commit routes are SitePilot's only content engine. To
stop SitePilot changing content on a site, define `SITEPILOT_V2_ENABLED` as the
boolean `false` in `wp-config.php`. Lookups keep working. There is deliberately
no wp-admin switch for it.

The signed v2 transport is rooted at `/wp-json/sitepilot/v2` and exposes
`editor-sessions`, `editor-bootstrap`, `prepare`, `commit`, `reconcile`,
`readback`, `recover`, and `conditional-support`. All routes except the
single-use bootstrap exchange require the existing HMAC headers over the exact
route path. Bootstrap values are accepted only in a POST body.

For draft compilation, `editor-sessions` creates an empty `auto-draft` solely
to obtain the destination post type's real editor bootstrap. It records the
execution on that scratch post and schedules deletion after the ten-minute
session expires. Existing-content compilation opens the requested post without
creating a scratch record. The native WordPress session token carries its
SitePilot scope server-side; every normal REST/admin/autosave write is denied,
and deleting one of WordPress's browser cookies cannot turn it into an
unrestricted login.

`prepare` applies the current WordPress content sanitizer, verifies candidate
and approval hashes, and refuses unsupported blocks or non-InnoDB tables.
Authorable blocks come from `includes/V2/block-manifest.json`, generated from
the TypeScript support matrix with `npm run generate:v2-block-manifest`; do not
edit it by hand. For updates, every block v2 cannot author must be a
byte-identical copy of a block in the source post, used at most once. New drafts
may contain only authorable blocks. Staged media may be JPEG, PNG, WebP, GIF,
MP4 or WebM, up to 10 MB per file.
`commit` locks the source row and durable journal in one transaction, rechecks
source fields/revision/content and runtime state, then returns a commit receipt
for pending verification. Final success is determined only by
fresh-editor readback in the hosted worker. WordPress hooks may cause external
side effects that a database rollback cannot make atomic; this limitation is
reported by the conditional-support response.
