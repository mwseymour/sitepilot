# HANDOFF_TASK_13

Handoff after completing **T11** (WordPress plugin scaffold), **T12** (MCP adapter + read-only tools), and **T13** (app-side MCP HTTP client). Next focus is **T14** (site registration / trust handshake) unless priorities change.

---

## 1. Current status

### Completed tasks

| Task    | Summary                                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T11** | WordPress plugin scaffold: Composer, bootstrap, Settings → SitePilot, public REST metadata (`/sitepilot/v1/health`, `/sitepilot/v1/protocol`).                                                                          |
| **T12** | `wordpress/mcp-adapter` via Composer; Abilities API abilities `sitepilot/ping` and `sitepilot/site-summary`; custom MCP server `sitepilot-bridge` on `/wp-json/sitepilot/mcp` (HTTP transport, logged-in `read` users). |
| **T13** | `@sitepilot/mcp-client`: `McpHttpClient` with JSON-RPC POST, `initialize` → `Mcp-Session-Id` header, then `tools/list`, `loadToolSchemas`, `tools/call`; unit test with mocked `fetch`.                                 |

### Locked architecture (do not regress)

- Electron renderer must not touch secrets, SQLite, or raw plugin HTTP without going through main + typed IPC.
- SQLite is metadata-only; secrets use `secureStorage` adapter (T08).
- Plugin protocol contracts (`@sitepilot/plugin-protocol`, `@sitepilot/contracts`) are the source of truth for signing and headers.
- WordPress MCP uses **official** `wordpress/mcp-adapter` (no fork of MCP packaging).
- MCP HTTP requires **session**: after `initialize`, WordPress sends `Mcp-Session-Id`; all subsequent JSON-RPC calls must include it (see `McpHttpClient`).

---

## 2. Key paths

### WordPress plugin

| Path                                                               | Role                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `plugins/wordpress-sitepilot/sitepilot.php`                        | Plugin bootstrap, constants `SITEPILOT_VERSION`, `SITEPILOT_PROTOCOL_VERSION`.                            |
| `plugins/wordpress-sitepilot/composer.json` / `composer.lock`      | `wordpress/mcp-adapter` dependency.                                                                       |
| `plugins/wordpress-sitepilot/includes/Plugin.php`                  | Loads REST, admin, `McpAdapter::instance()`, abilities + MCP server registrars.                           |
| `plugins/wordpress-sitepilot/includes/Rest/Protocol_Routes.php`    | `GET .../health`, `GET .../protocol`.                                                                     |
| `plugins/wordpress-sitepilot/includes/Admin/Settings_Page.php`     | Settings UI + endpoint URLs.                                                                              |
| `plugins/wordpress-sitepilot/includes/Mcp/Abilities_Registrar.php` | `wp_abilities_api_*` hooks for `sitepilot/ping`, `sitepilot/site-summary`.                                |
| `plugins/wordpress-sitepilot/includes/Mcp/Server_Registrar.php`    | `mcp_adapter_init` priority 100 → `create_server(..., ['sitepilot/ping','sitepilot/site-summary'], ...)`. |
| `plugins/wordpress-sitepilot/vendor/`                              | **Gitignored** — run `composer install` in the plugin directory.                                          |

**Protocol constant:** `SITEPILOT_PROTOCOL_VERSION` is `1.0.0` (must stay aligned with desktop expectations and `parseSiteRegistration` / `protocolHealthSchema` usage).

**MCP URL (desktop):** `https://{host}/wp-json/sitepilot/mcp` — use with authenticated WordPress requests (cookies or app passwords / future signed requests).

### TypeScript MCP client

| Path                                     | Role                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/mcp-client/src/http-client.ts` | `McpHttpClient`: `connect()` / `initialize` + session persistence; `listTools`, `loadToolSchemas`, `callTool`. |
| `packages/mcp-client/src/types.ts`       | JSON-RPC + tool list types.                                                                                    |
| `tests/mcp-client.test.ts`               | Mock-fetch tests for initialize + session + `tools/list`.                                                      |

---

## 3. Requirements & environment

- **WordPress:** 6.9+ (Abilities API in core). Plugin header matches this.
- **PHP:** 8.1+.
- **PHP deps:** `cd plugins/wordpress-sitepilot && composer install` (vendor not committed).
- **Node:** `npm run typecheck`, `lint`, `test`, `format`, `npm run build -w @sitepilot/desktop` were run successfully after T13.

---

## 4. What T14 will need (preview)

- Wire **site registration** and **trust handshake** between desktop and plugin (T08 secure storage, T10 protocol, T11–T13 connectivity).
- Likely: authenticated calls to plugin REST + MCP using **signed requests** (not only cookie/session), aligned with `signedRequestHeadersSchema` and `buildSigningInput`.
- Persist **non-secret** metadata in SQLite via repositories; secrets only in secure storage.

---

## 5. Known gaps / risks

- **No E2E** against a live WordPress in CI — only PHP file structure + TS unit tests for MCP client.
- **MCP auth**: Current server uses transport permission `is_user_logged_in() && current_user_can('read')`. Production will need **application passwords** or **signed requests** for remote desktop; T14 should address this.
- **`composer.json` removed `wordpress/abilities-api`** package — rely on **core WP 6.9+**; do not re-add the abandoned package without a deliberate compatibility decision.
- **Prettier:** `plugins/wordpress-sitepilot/vendor` is listed in `.prettierignore` so `vendor` is not formatted.

---

## 6. Suggested first actions for the next chat

1. Read `docs/task-graph.md` row **T14** and `docs/architecture.md` (plugin trust boundaries).
2. Re-read `packages/contracts/src/protocol.ts` and `packages/plugin-protocol/src/` for signing/registration.
3. Decide how the desktop app authenticates to WordPress MCP (session vs signed vs app password) for T14.
4. Run `composer install` in `plugins/wordpress-sitepilot` before any PHP change.

---

## 7. Verification checklist (for the next agent)

```sh
npm run typecheck && npm run lint && npm run test && npm run format
npm run build -w @sitepilot/desktop
cd plugins/wordpress-sitepilot && composer install && composer validate --no-check-publish
```

---

_End of T13 handoff._
