# HANDOFF_TASK_16

Handoff after completing **T15** (connectivity diagnostics) and **T16** (discovery service + persistence). Next focus is **T17** (AI-generated first-pass site config draft from discovery snapshot) unless priorities change.

---

## 1. Current status

### Completed tasks

| Task    | Summary                                                                                                                                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T15** | Typed IPC `site.runDiagnostics`: health reachability, protocol metadata + semver compatibility (`compareProtocolCompatibility`), signed MCP `initialize`, `tools/list` + tool names, plugin version from protocol. Shared helpers in `site-site-context.ts` (load site, secret, fetch protocol, build `McpHttpClient`). |
| **T16** | IPC `site.refreshDiscovery`: MCP `sitepilot/site-discovery` tool call, `normalizeMcpToolResult` in `@sitepilot/mcp-client`, new WordPress ability `sitepilot/site-discovery` (`Site_Discovery.php`), persisted `DiscoverySnapshot` + `sites.latest_discovery_snapshot_id` update.                                       |

### Locked architecture (do not regress)

- Renderer must use only typed IPC; no SQLite, secrets, or raw plugin HTTP in the renderer.
- Shared secrets remain in **secure storage**; SQLite holds **metadata** only (`DiscoverySnapshot.summary` is JSON; no secrets).
- MCP session flow unchanged: `**initialize` → `Mcp-Session-Id` → subsequent JSON-RPC\*\* (`McpHttpClient`).
- WordPress MCP transport permission: **logged-in `read`** **or** **valid SitePilot HMAC** (`Mcp_Permission`).

---

## 2. Key paths

### Desktop (main)

| Path                                                | Role                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/site-site-context.ts`        | `loadRegisteredSiteContext`, `fetchProtocolMetadata`, `createMcpClientForSite` (signed MCP). |
| `apps/desktop/src/main/connectivity-diagnostics.ts` | `runConnectivityDiagnostics(siteId)` → `ConnectivityDiagnosticsResult`.                      |
| `apps/desktop/src/main/discovery-service.ts`        | `refreshDiscoveryForSite(siteId)` → `RefreshDiscoveryResponse`.                              |
| `apps/desktop/src/main/ipc.ts`                      | Handlers for `site.runDiagnostics`, `site.refreshDiscovery`.                                 |

### Contracts / MCP

| Path                                     | Role                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/ipc.ts`          | `connectivityDiagnosticsSchema`, `siteIdRequestSchema`, `persistedDiscoverySnapshotSchema`, `refreshDiscoveryResponseSchema`. |
| `packages/mcp-client/src/tool-result.ts` | `normalizeMcpToolResult` (WordPress `structuredContent` / `content` shapes).                                                  |

### WordPress plugin

| Path                                                               | Role                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `plugins/wordpress-sitepilot/includes/Mcp/Site_Discovery.php`      | `Site_Discovery::collect()` — post types, taxonomies, nav menus, theme, active plugins, SEO plugin hints, warnings. |
| `plugins/wordpress-sitepilot/includes/Mcp/Abilities_Registrar.php` | Registers `sitepilot/site-discovery` ability.                                                                       |
| `plugins/wordpress-sitepilot/includes/Mcp/Server_Registrar.php`    | MCP server tools include `sitepilot/site-discovery`.                                                                |

---

## 3. Requirements & environment

- **WordPress** 6.9+, **PHP** 8.1+.
- `**composer install`\*\* in `plugins/wordpress-sitepilot` before PHP work.
- **Node**: `npm run typecheck`, `lint`, `test`, `format`, `npm run build -w @sitepilot/desktop`.

---

## 4. What T17 will need (preview)

- Consume `DiscoverySnapshot` (especially `summary.discovery`) and map into `**SiteConfig`\*\* draft via `siteConfigSchema` / `packages/contracts`.
- Respect activation gating (T18) — draft only until user confirms.

---

## 5. Known gaps / risks

- **No live WordPress in CI** — discovery normalization is unit-tested; full MCP + discovery round-trip is manual.
- **Discovery depth**: `sitepilot/site-discovery` is intentionally read-only and shallow (no ACF field group inspection yet); extend with additional abilities or REST when needed.
- **Field-level schema** (`fieldSchema` in older `discoverySnapshotSchema` contract) is **not** populated yet; the persisted `DiscoverySnapshot` matches **domain** (`summary` JSON holds the richer payload).

---

## 6. Suggested first actions for the next chat

1. Read `docs/task-graph.md` row **T17** and `packages/contracts` `siteConfigSchema`.
2. Design mapping from `summary.discovery` (and site metadata) into `SiteConfig` sections.
3. Add a **main-process** draft service (not renderer) with tests using fixtures from `DiscoverySnapshot` JSON.

---

## 7. Verification checklist

```sh
npm run typecheck && npm run lint && npm run test && npm run format
npm run build -w @sitepilot/desktop
cd plugins/wordpress-sitepilot && composer install && composer validate --no-check-publish
```

---

_End of T16 handoff._
