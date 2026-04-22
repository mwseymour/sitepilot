# SitePilot WordPress plugin

Thin companion plugin for the SitePilot desktop app: protocol metadata REST routes, `wordpress/mcp-adapter` integration, and read-only MCP tools.

For block editor writes, the plugin accepts structured parsed block arrays in `blocks`, validates and sanitizes them recursively, canonicalizes common core block shapes, and serializes them with WordPress core `serialize_blocks()`. See [Reliable Gutenberg Block Generation](../../docs/reliable-gutenberg-blocks.md) for the contract, debugging notes, and failure modes.

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
