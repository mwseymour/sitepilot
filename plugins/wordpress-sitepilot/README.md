# SitePilot WordPress plugin

Thin companion plugin for the SitePilot desktop app: protocol metadata REST routes, `wordpress/mcp-adapter` integration, and read-only MCP tools.

For block editor writes, the plugin accepts structured parsed block arrays in `blocks`, validates and sanitizes them recursively, canonicalizes common core block shapes, and serializes them with WordPress core `serialize_blocks()`. See [Reliable Gutenberg Block Generation](../../docs/reliable-gutenberg-blocks.md) for the contract, debugging notes, and failure modes. For third-party block loading, see [Custom Block Support](../../docs/custom-block-support.md).

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
| MCP (HTTP, JSON-RPC) | POST   | `/wp-json/sitepilot/mcp`         |

MCP calls require a logged-in user with `read` capability (or stronger). After `initialize`, send the `Mcp-Session-Id` header on subsequent JSON-RPC requests (handled automatically by `@sitepilot/mcp-client`).

## Composer packages

- [`wordpress/mcp-adapter`](https://packagist.org/packages/wordpress/mcp-adapter) — official WordPress MCP bridge (HTTP transport).

Vendor directory is gitignored; run `composer install` after clone.

## Gutenberg v2 feasibility gate

The v2 editor bridge and commit routes are additive and disabled by default. A
deployment must define `SITEPILOT_V2_ENABLED` as the boolean `true` only after
the target-site authentication, editor-runtime, and InnoDB transaction checks
have passed. There is deliberately no wp-admin switch that can bypass that
gate.

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
`commit` locks the source row and durable journal in one transaction, rechecks
source fields/revision/content and runtime state, then returns a commit receipt
for pending verification. Final success is determined only by
fresh-editor readback in the hosted worker. WordPress hooks may cause external
side effects that a database rollback cannot make atomic; this limitation is
reported by the conditional-support response.
