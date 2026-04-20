# HANDOFF_TASK_22

Handoff after completing **T22** (clarification engine: missing-info detection + duplicate / near-duplicate warnings on typed chat requests). Per `docs/task-graph.md`, **T24** (schema-valid planner → `ActionPlan`) depends on **T21**, **T22**, and **T23**; the natural next serial work is **T23** (provider abstraction + telemetry) unless priorities change.

---

## 1. Current status

### Completed (T22 scope)

| Area                 | Summary                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Heuristic engine** | `analyzeClarification` in `@sitepilot/services` — deterministic rules: “vague” if prompt is short or has fewer than three words; Jaccard token overlap vs recent site prompts (threshold **0.72**) for near-duplicate warnings; exact string match for duplicate warning. |
| **Persistence**      | `ClarificationRound` saved when `needsClarification`; `Request.status` is **`clarifying`** vs **`new`** based on analysis. System messages for duplicate warnings; assistant message listing numbered questions when clarification is needed.                             |
| **Recent prompts**   | `SqliteRequestRepository.listBySiteId(siteId)` (newest first, capped) feeds `recentPromptsForSite` for similarity checks.                                                                                                                                                 |
| **Contracts**        | `clarificationRoundSchema` + `createChatRequest` response includes optional `clarificationRound` (omit when absent — **exactOptional** / IPC shape).                                                                                                                      |
| **Tests**            | `tests/clarification-engine.test.ts` (vague / near-duplicate / clear prompt); sqlite round-trip for messages + clarification rounds in `tests/sqlite-repositories.test.ts`.                                                                                               |

### Locked behavior (do not regress without intent)

- Clarification logic stays **main-process** (`@sitepilot/services` + `chat-service`); renderer only calls typed IPC.
- `createChatRequest` must not send `clarificationRound: undefined` in JSON — use conditional spread (see `apps/desktop/src/main/ipc.ts`).

---

## 2. Key paths

| Path                                                | Role                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/services/src/clarification-engine.ts`     | `analyzeClarification`, `ClarificationAnalysis`, tokenization + Jaccard.                                                             |
| `packages/services/src/index.ts`                    | Re-exports clarification API.                                                                                                        |
| `apps/desktop/src/main/chat-service.ts`             | `createTypedRequestForThread` — runs analysis, saves request + messages + optional `clarificationRound`, updates thread `updatedAt`. |
| `packages/contracts/src/schemas.ts`                 | `clarificationRoundSchema`.                                                                                                          |
| `packages/contracts/src/ipc.ts`                     | `createChatRequest` request/response schemas.                                                                                        |
| `packages/repositories/src/sqlite-repositories.ts`  | `SqliteClarificationRoundRepository`, `listBySiteId` on requests.                                                                    |
| `apps/desktop/src/renderer/pages/site/ChatPage.tsx` | UI copy references typed request + clarification / duplicate behavior.                                                               |

---

## 3. Known gaps / limits

- **Heuristics only** — no LLM; thresholds (`12` chars, `3` words, `0.72` Jaccard) are tunable constants, not learned.
- **No answer loop yet** — `ClarificationRound.answers` stays empty until a future flow records operator replies and transitions `Request` out of `clarifying`.
- **Duplicate warnings are informational** — request is still created; UX does not block on warnings.
- **Language** — tokenization is ASCII-alphanumeric oriented; non-English prompts may behave oddly.

---

## 4. Suggested first actions for the next chat (if continuing the request pipeline)

1. Read `docs/task-graph.md` rows **T23** and **T24**.
2. For **T24**: wire `buildPlannerContext` + clarification state into a planner that consumes `PlannerContext` and emits `ActionPlan` (only when not blocked on clarification, or with explicit assumptions).
3. Optionally: IPC + UI to **submit clarification answers** and resolve `ClarificationRound` / `Request` status (`clarification_answered` audit events exist in domain enums for future use).

---

## 5. Verification checklist

```sh
npm run typecheck && npm run lint && npm run test && npm run format
npm run build -w @sitepilot/desktop
```

---

_End of T22 handoff._
