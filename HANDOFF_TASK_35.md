# HANDOFF_TASK_35

Handoff after completing **T31–T35** (audit filtering UI, settings + planner preferences, rollback metadata / reversibility signals, integration coverage, export–import + compatibility + packaging metadata). Per `docs/task-graph.md`, the numbered task graph currently ends at **T35**; further work is product backlog beyond that list unless you extend the graph.

---

## 1. Current status

### Completed (T31–T35 scope)

| ID   | Area                    | Summary                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T31  | **Audit filtering**     | `AuditEntryRepository.queryForSite` + `AuditSiteQuery` (site, optional request/action, event types, ISO since/until, execution outcome, rollback-only, limit). IPC `listAuditEntries` extended. `AuditPage` filter form + action column + links.                                                                                          |
| T32  | **Settings**            | Global **`/settings`**: provider key save/remove (secure storage), planner defaults (preferred provider + model strings), compatibility blurb via `getCompatibilityInfo`. Per-site **`/site/:siteId/settings`**: workspace planner overrides, forget site signing secret, export/import entry. `plan-generation-service` uses `loadPlannerPreferences` + `choosePlannerProvider`. |
| T33  | **Rollback / reversal** | After successful real MCP execution, if tool result includes a **`before`** object, main process appends audit **`rollback_recorded`** with snapshot metadata. Plugin **create-draft-post** responses include **`reversible`** / **`compensation_required`** (draft creation treated as not trivially reversible).                      |
| T34  | **Integration test**    | `tests/integration-workflow.test.ts` exercises `queryForSite` filters (request scope, execution failed, rollback-only) on a temp SQLite DB.                                                                                                                                                                                              |
| T35  | **Export / import**     | `export.buildSiteBundle` → JSON (site, config versions, audits, `exportId`; **no secrets**). `import.applySiteBundle` validates bundle, appends audits with new ids + `sitepilotImport` metadata, inserts **missing** config versions only (skips existing `site_id`+`version`). `app.getCompatibilityInfo` + shared `SITEPILOT_PROTOCOL_VERSION` in `compatibility-info.ts` / `register-site`. `electron-builder` **`extraMetadata`** protocol fields in `apps/desktop/package.json`. |

### Locked behavior (do not regress without intent)

- **Secrets never round-trip to the renderer** — `getSettingsState` only reports which providers are configured, not key material.
- **`SecretNamespace`** includes **`app`** for encrypted planner preference blobs (`planner_prefs`, `planner_prefs:ws:…`); keep key naming stable or migrate deliberately.
- **Audit remains append-only** — import **appends** audits; it does not rewrite history. Re-importing the same bundle can duplicate audit rows (no dedup by `exportId` yet).
- **Filter semantics** — `queryForSite` combines clauses with **AND**; overlapping filters (e.g. event type multi-select + execution outcome) can legitimately return zero rows.

---

## 2. Key paths

| Path                                                                 | Role                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/repositories/src/interfaces.ts`                            | `AuditSiteQuery`, `AuditEntryRepository.queryForSite`.                                                                                      |
| `packages/repositories/src/sqlite-repositories.ts`                   | `SqliteAuditEntryRepository.queryForSite` (dynamic `WHERE` + `LIMIT`).                                                                     |
| `apps/desktop/src/main/audit-query-service.ts`                       | `listAuditEntriesForSite` → `queryForSite`.                                                                                                 |
| `packages/contracts/src/ipc.ts`                                      | Extended `listAuditEntriesRequestSchema`; settings, compatibility, export/import channels + `SitePilotDesktopApi` method names.             |
| `apps/desktop/src/main/ipc.ts`                                       | Handlers for new channels; audit forward of all filter fields.                                                                              |
| `apps/desktop/src/preload/index.ts`                                  | `window.sitePilotDesktop` bridge for new APIs.                                                                                              |
| `apps/desktop/src/renderer/pages/site/AuditPage.tsx`                 | T31 operator filters + table.                                                                                                               |
| `apps/desktop/src/main/planner-preferences-service.ts`               | Global vs workspace merged planner prefs in secure storage (`app` namespace).                                                               |
| `apps/desktop/src/main/settings-service.ts`                          | `getSettingsState`, provider key mutations, planner save, `clearSiteSigningSecret`.                                                         |
| `apps/desktop/src/main/plan-generation-service.ts`                   | `choosePlannerProvider` + model strings from prefs.                                                                                         |
| `apps/desktop/src/main/execution-orchestrator-service.ts`            | `rollback_recorded` audit when `mcpResult.before` is present.                                                                               |
| `plugins/wordpress-sitepilot/includes/Mcp/Write_Abilities.php`       | Draft post output: `reversible` / `compensation_required`; updates/SEO already expose `before`/`after`.                                     |
| `apps/desktop/src/main/export-site-service.ts` / `import-site-service.ts` | Build / apply site bundle (JSON).                                                                                                      |
| `apps/desktop/src/main/compatibility-info.ts`                        | Protocol version constants + `getCompatibilityPayload`; used by `register-site.ts`.                                                         |
| `apps/desktop/src/renderer/pages/SettingsPage.tsx`                   | Global settings UI.                                                                                                                         |
| `apps/desktop/src/renderer/pages/site/SiteSettingsPage.tsx`          | Per-site trust, workspace planner overrides, export download + import file picker.                                                          |
| `tests/integration-workflow.test.ts`                                 | T34-style audit query integration test.                                                                                                     |
| `tests/ipc-contracts.test.ts`                                        | Stub `SitePilotDesktopApi` includes all new methods.                                                                                         |

---

## 3. Known gaps / limits

- **Import idempotency** — Re-applying the same export duplicates audit rows; consider storing applied `exportId` (e.g. secure storage or dedicated table) if operators need safe re-run.
- **Rollback audit** — Fires when **`before`** exists on the normalized tool result; create-draft does not populate `before`, so only **update fields / SEO** paths get `rollback_recorded` today.
- **E2E automation** — T34 is SQLite-level only; no full Electron + live WordPress MCP chain in CI yet.
- **Task graph** — T35 was the last defined ID; next priorities are not enumerated in `docs/task-graph.md`.

---

## 4. Suggested first actions for the next chat

1. Decide whether to **extend `docs/task-graph.md`** (Phase 6+, or operational tasks) or treat T35 as the v1 cut line.
2. If import safety matters: add **dedup** or **dry-run import** IPC that reports would-import counts without writing.
3. Optional UX: **multi-select** event types in `AuditPage` (IPC already accepts `eventTypes[]`; UI currently sends at most one).
4. Optional: **clarification answer loop** (domain already has `clarification_answered` audit type) to move requests out of `clarifying`.

---

## 5. Verification checklist

```sh
npm run typecheck && npm run lint && npm run test && npm run format
npm run build -w @sitepilot/desktop
```

---

_End of T35 handoff._
