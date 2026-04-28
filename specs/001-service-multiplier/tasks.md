---
description: "Task list for Service Multiplier (服务倍率) — feature 001-service-multiplier"
---

# Tasks: Service Multiplier (服务倍率)

**Input**: Design documents from `/specs/001-service-multiplier/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are not requested in the spec. A small set of targeted unit tests is included in the Polish phase as **optional** smoke coverage; skip those if the team prefers to rely on manual verification via `quickstart.md`.

**Organization**: Tasks are grouped by user story (US1 P1 → US2 P2 → US3 P3) so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label — only applied to story-phase tasks
- All file paths are absolute or rooted at the repository (`/Users/linwang/src/github/xiluo/claude-relay-service`)

## Path Conventions

- Backend: `src/services/`, `src/routes/`, `src/routes/admin/`, `src/models/`
- Frontend (Vue 3 SPA): `web/admin-spa/src/views/`, `web/admin-spa/src/components/apikeys/`, `web/admin-spa/src/config/`, `web/admin-spa/src/stores/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: This is an extension to an existing project, so Setup is minimal. Only one preparatory step.

- [X] T001 Verify dev environment runs cleanly: `npm install && npm run dev` brings the API up and the SPA loads at `/admin-next/`; Redis is reachable; admin login works. Document any environment quirks in `specs/001-service-multiplier/quickstart.md` if encountered.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The new service module and Redis helpers must exist before any user story is wired in. All three user stories depend on `serviceRatesService` being importable.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Create `src/services/serviceRatesService.js` exposing:
  - default rate map and `baseService = 'claude'` (per `data-model.md` E1).
  - `detectService(accountType, model)` implementing R2 mapping (account type → service ID with model-name fallback; `openai`/`openai-responses` → `codex`).
  - In-memory cache with 60 s TTL (R4): `getRates()` returns the merged (defaults ∪ stored) config, refreshing from Redis on miss/expiry.
  - `getPublicRates()` returns the same payload **without** `updatedBy` (FR-011).
  - `getRate(service)` returns the cached numeric multiplier or `1.0` if unknown.
  - `saveRates({ rates, baseService, adminUsername })` validates every rate `> 0` and finite, persists via the new Redis helper, sets `updatedAt`/`updatedBy`, invalidates the cache, returns the new config.
  - `computeRatedCost({ realCost, service, keyOverrides })` returns `realCost × globalRate(service) × (keyOverrides[service] ?? 1.0)`.
  - `parseKeyOverrides(rawString)` parses the `serviceRates` field on an API Key hash; on parse error logs `warn` and returns `{}` (FR-017).
  - On **any** read failure of the global config (Redis error, parse error, etc.), log a `warn` and return all-1.0 so callers fail open (FR-019).
- [X] T003 [P] Add Redis helpers in `src/models/redis.js`:
  - `getServiceRatesConfig()` reads key `system:service_rates` and returns `{ rates, baseService, updatedAt, updatedBy }` or `null`.
  - `setServiceRatesConfig(config)` writes the same shape (JSON-stringified hash field or hash with primitive fields — implementer's choice; preserve atomicity).

**Checkpoint**: `serviceRatesService` is importable and unit-callable from a Node REPL. User story implementation can now begin.

---

## Phase 3: User Story 1 — Configure Global Service Rates in System Settings (Priority: P1) 🎯 MVP

**Goal**: Admin can set per-service multipliers in the SPA's System Settings → 服务倍率 tab; new requests record `ratedCost = realCost × globalRate`; quotas deduct `ratedCost`.

**Independent Test**: Admin sets Gemini=0.5, saves, refreshes the page, sees 0.5 persisted with timestamp + admin username; a real Gemini request through an API Key (no per-key override) records `ratedCost = realCost × 0.5` and `usage:cost:daily:{keyId}:{date}` advances by `ratedCost`.

### Implementation for User Story 1

- [X] T004 [P] [US1] Create admin route module `src/routes/admin/serviceRates.js` implementing the three endpoints in `contracts/admin-service-rates.openapi.yaml`:
  - `GET /service-rates` → returns `serviceRatesService.getRates()` (admin payload, includes `updatedBy`).
  - `PUT /service-rates` → body `{ rates, baseService? }`; validates every value `> 0`/finite, calls `serviceRatesService.saveRates({ ..., adminUsername: req.admin.username })`; returns the saved config.
  - `GET /service-rates/services` → returns the array of `ServiceListEntry` (id/name/rate/isBase/icon/gradient) per `data-model.md` E4.
  - All three guarded by the existing `authenticateAdmin` middleware.
- [X] T005 [US1] Mount the new sub-router from `src/routes/admin.js` (e.g. add `router.use('/', require('./admin/serviceRates'))` near the existing `apiKeyRegenerateRoutes` mount around line 47). Depends on T004.
- [X] T006 [US1] Wire `computeRatedCost` into `apiKeyService.recordUsage` in `src/services/apiKeyService.js` (around line 1263):
  - After `costInfo` is computed, call `serviceRatesService.detectService(null, model)` (no `accountType` available in this path) to pick the bucket.
  - Call `computeRatedCost({ realCost: costInfo.costs.total, service, keyOverrides: {} })` (per-key overrides handled in US2).
  - Pass `ratedCost` (not `realCost`) to `redis.incrementDailyCost`, `redis.incrementWeeklyCost`, and as the cost arg to `redis.incrementTokenUsage`.
  - In `redis.addUsageRecord(...)` add a new `ratedCost` field alongside the existing `cost` (= `realCost`); leave `cost` unchanged for backward compatibility (R7).
- [X] T007 [US1] Wire `computeRatedCost` into `apiKeyService.recordUsageWithDetails` in `src/services/apiKeyService.js` (around line 1477) following the same pattern as T006, but use the `accountType` parameter as the primary input to `detectService(accountType, model)`. Pay particular attention to the booster-pack branches further down the function — they must also use `ratedCost` (not `realCost`) for the per-key cost increments.
- [X] T008 [US1] Audit admin-side stats reads in `src/routes/admin.js` (`/api-keys/:keyId/cost-debug`, dashboard endpoints, etc.) and ensure they expose **both** `realCost` and `ratedCost` columns when reading usage records. Use the fallback `record.ratedCost ?? record.cost` so historical pre-feature records render correctly (FR-016, R7).
- [X] T009 [US1] Audit key-facing endpoints (`/api/v1/usage`, `/api/v1/key-info` in `src/routes/api.js`) and ensure responses expose **only** `ratedCost` under whatever existing field name they use (e.g. `cost`, `total.cost`). `realCost` MUST NOT appear in any field returned to API Key holders (FR-009a).
- [X] T010 [P] [US1] Add HTTP client functions in `web/admin-spa/src/config/api.js`:
  - `getAdminServiceRatesApi()` → `GET /admin/service-rates`.
  - `updateAdminServiceRatesApi({ rates, baseService })` → `PUT /admin/service-rates`.
  - `getAdminServiceRatesServicesApi()` → `GET /admin/service-rates/services`.
- [X] T011 [P] [US1] Add the "服务倍率" tab to `web/admin-spa/src/views/SettingsView.vue`:
  - Add a new tab button mirroring the existing branding/webhook pattern (lines ~18, 30) with `activeSection === 'serviceRates'`.
  - Add a new `<div v-show="activeSection === 'serviceRates'">` section rendering a responsive grid of cards (one per service) with: name, icon, gradient badge, "基准服务" badge for `baseService`, and a numeric `<input type="number" min="0.1" max="10" step="0.1">` bound to `rates[service]`.
  - Display "最后更新: {updatedAt} 由 {updatedBy} 修改" line (only the admin endpoint includes `updatedBy`).
  - Add Save button: disabled while `serviceRatesSaving === true`; surfaces success and validation errors.
  - Reactive data: `serviceRates`, `serviceRatesLoading`, `serviceRatesSaving`.
  - All styling MUST include `dark:` variants and responsive breakpoints (FR-018).
  - Lazy-load on first activation by extending the existing `sectionWatcher` (around line 1313) with a `serviceRates` branch that calls `loadServiceRates()`.
- [X] T012 [US1] Wire `loadServiceRates()` and `saveServiceRates()` in `SettingsView.vue` to the API functions from T010. On save, refresh the local state from the response (so `updatedAt`/`updatedBy` reflect the latest write). Depends on T010 and T011.

**Checkpoint**: User Story 1 is fully functional. Run quickstart.md sections 1, 2, 4, 5, 7 to validate.

---

## Phase 4: User Story 2 — Per-API-Key Rate Override (Priority: P2)

**Goal**: Admin can attach a per-service override map to a specific API Key from the existing Create/Edit API Key modal; the override composes multiplicatively with the global rate (`ratedCost = realCost × globalRate × keyRate`).

**Independent Test**: Create an API Key with `serviceRates = { gemini: 0.8 }` while global Gemini = 0.5; issue a Gemini request whose `realCost = $1.00`; verify `ratedCost = $0.40`.

### Implementation for User Story 2

- [X] T013 [P] [US2] Extend `POST /admin/api-keys` handler in `src/routes/admin.js` (around line 1050) to accept an optional `serviceRates` body field. Validate: each value is a finite number `> 0`; service IDs are in the supported set (warn-and-drop unknown ones). Persist as `JSON.stringify(serviceRates || {})` on the `api_key:{id}` hash field `serviceRates`.
- [X] T014 [P] [US2] Extend `PUT /admin/api-keys/:keyId` handler in `src/routes/admin.js` (around line 1571) identically. An empty object or absent field clears any existing override.
- [X] T015 [US2] In `apiKeyService.recordUsage` and `recordUsageWithDetails` (the same code paths edited in T006 / T007), parse `keyData.serviceRates` via `serviceRatesService.parseKeyOverrides(keyData.serviceRates)` and pass the result as `keyOverrides` to `computeRatedCost`. The `keyData` object is already loaded by the existing `redis.getApiKey` calls in those functions.
- [X] T016 [P] [US2] Add a "Service Rate Overrides" collapsible section to `web/admin-spa/src/components/apikeys/CreateApiKeyModal.vue`:
  - Renders one numeric input per supported service (same `min/max/step` constraints as US1).
  - Empty / `1.0` values are normalized to "no override" before submission.
  - Helper text explaining the compose-with-global semantics with a small worked example.
  - Dark-mode + responsive styling.
- [X] T017 [P] [US2] Add the same "Service Rate Overrides" section to `web/admin-spa/src/components/apikeys/EditApiKeyModal.vue`. On open, populate from the API Key's existing `serviceRates`. On save, send the field with the rest of the form. Identical validation and styling rules to T016.
- [X] T018 [US2] Update the Pinia store `web/admin-spa/src/stores/apiKeys.js` (and any helper service in `web/admin-spa/src/config/api.js`) so the create / update API Key actions pass through the `serviceRates` field unchanged. Ensure list/detail responses surface the parsed override map for display in the Edit modal.

**Checkpoint**: User Story 2 is fully functional. Run quickstart.md section 3 to validate.

---

## Phase 5: User Story 3 — Public Read-Only Endpoint (Priority: P3)

**Goal**: An unauthenticated client can fetch the current global multiplier configuration (without `updatedBy`).

**Independent Test**: `curl http://localhost:3000/apiStats/service-rates` returns `{ rates, baseService, updatedAt }` with no `updatedBy` field, even after admins have saved.

### Implementation for User Story 3

- [X] T019 [US3] Add `GET /service-rates` handler in `src/routes/apiStats.js` (mounted under `/apiStats`):
  - No auth middleware — endpoint is intentionally public.
  - Return `await serviceRatesService.getPublicRates()` as JSON. The function already strips `updatedBy` (T002).
  - Set conservative caching (`Cache-Control: public, max-age=30`) so this can absorb pricing-page traffic without hitting Redis on every call.

**Checkpoint**: User Story 3 is fully functional. Run quickstart.md section 6 to validate.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Quality gates and verification across all stories. Optional unit tests live here.

- [X] T020 [P] Run `npx prettier --write` on every modified file (backend and SPA). Verify with `npx prettier --check`.
- [X] T021 [P] Run `npm run lint` and resolve any new errors introduced by US1–US3 work.
- [X] T022 [P] **(Optional)** Add unit tests in `tests/unit/services/serviceRatesService.test.js` (Jest) covering: defaults, validation rejection of `0` / negative / non-finite, fail-open on Redis error, malformed override JSON degradation, composition formula correctness with both factors present.
- [X] T023 [P] **(Optional)** Add an integration test in `tests/integration/serviceRates.test.js` (SuperTest) that exercises the admin GET/PUT cycle and verifies a request flow records `ratedCost` correctly.
- [X] T024 Manually walk through every section (1–8) of `specs/001-service-multiplier/quickstart.md` against a running dev environment. Record results in the PR description.
- [X] T025 [P] Verify dark-mode and responsive behaviour for the new SettingsView tab and both API Key modals at widths 375 px / 768 px / 1280 px.
- [X] T026 Verify backward compatibility (FR-016, R7): with no admin save ever performed, every relayed request still records `ratedCost == realCost` and admin stats display correctly for pre-feature usage records that lack the `ratedCost` field.
- [X] T027 Final PR checklist: confirm Constitution Check (plan.md) still passes; confirm `CLAUDE.md` still reflects the current tech context (already updated by `/speckit.plan`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion. **Blocks all user stories.**
- **User Stories (Phase 3+)**: All depend on Foundational completion.
  - US1, US2, US3 are independently shippable and can be staffed in parallel after Foundational.
- **Polish (Phase 6)**: Depends on whichever user stories are being shipped in the current PR.

### User Story Dependencies

- **US1 (P1)**: Independent — only depends on Foundational. **MVP.**
- **US2 (P2)**: Independent of US1's UI but the override composition (T015) reuses the same edits made by T006 / T007. If US1 and US2 ship in the same PR, T015 can be folded into T006 / T007. If US1 ships first standalone, T015 is a small follow-up edit to those two functions.
- **US3 (P3)**: Fully independent. Only depends on Foundational (`serviceRatesService.getPublicRates`).

### Within Each User Story

- Backend route handlers depend on the service module (already in Foundational).
- Mounting the admin sub-router (T005) depends on the sub-router file existing (T004).
- SPA "wire it up" tasks (T012) depend on the API client (T010) and the markup (T011).
- The booster-pack code paths inside `recordUsageWithDetails` must be edited in the same task as the main path (T007) to avoid regressions; do not split.

### Parallel Opportunities

- T002 and T003 in Foundational can be developed in parallel by different people (different files).
- Inside US1: T004 (admin route module), T010 (API client), T011 (SettingsView markup) are all `[P]` and can proceed in parallel until T005, T006/T007, and T012 stitch them together.
- Inside US2: T013 + T014 (separate handlers in the same file — same-file conflict, do them sequentially or in a single edit), T016 + T017 (separate Vue files — `[P]`), T018 (store).
- US1, US2, US3 themselves can all be done in parallel after Phase 2.
- All Polish tasks marked `[P]` are file-independent.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Two devs can work in parallel:
Task: "Create src/services/serviceRatesService.js (T002)"
Task: "Add Redis helpers in src/models/redis.js (T003)"
```

## Parallel Example: User Story 1

```bash
# Three independent tracks once Foundational is done:
Task: "Create src/routes/admin/serviceRates.js (T004)"
Task: "Add HTTP client functions to web/admin-spa/src/config/api.js (T010)"
Task: "Add SettingsView.vue tab markup (T011)"

# Then merge tracks:
Task: "Mount sub-router in src/routes/admin.js (T005)"
Task: "Wire computeRatedCost into apiKeyService recordUsage (T006)"
Task: "Wire computeRatedCost into recordUsageWithDetails (T007)"
Task: "Wire SettingsView.vue load/save handlers (T012)"
```

## Parallel Example: User Story 2

```bash
# Markup tracks in parallel:
Task: "Add overrides section to CreateApiKeyModal.vue (T016)"
Task: "Add overrides section to EditApiKeyModal.vue (T017)"

# Backend (single file, sequential):
Task: "Extend POST /admin/api-keys (T013)"
Task: "Extend PUT /admin/api-keys/:keyId (T014)"
Task: "Compose key overrides in apiKeyService (T015)"

# Then store:
Task: "Update apiKeys Pinia store (T018)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001).
2. Complete Phase 2: Foundational (T002, T003).
3. Complete Phase 3: User Story 1 (T004–T012).
4. **STOP and VALIDATE**: walk through quickstart.md sections 1, 2, 4, 5, 7.
5. Ship — operators can now globally re-rate every service.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. + US1 → MVP shipped (global rates only).
3. + US2 → per-key fine-tuning available.
4. + US3 → public transparency endpoint live.
5. + Polish → format / lint / quickstart walk-through / optional unit + integration tests.

### Single-PR Delivery (recommended for this small surface)

Because the diffs are tightly coupled (apiKeyService edits cover both US1 and US2; SettingsView tab + apiKeys modal sections are small), a single PR delivering all three stories is realistic. Sequence:

1. T001 → T002 → T003 (single commit each).
2. T004 → T005 → T006 → T007 → T008 → T009 (US1 backend; one or two commits).
3. T013 → T014 → T015 (US2 backend; one commit).
4. T010 → T011 → T012 → T016 → T017 → T018 (frontend; one commit).
5. T019 (US3 endpoint).
6. T020 → T021 → T024 → T025 → T026 → T027 (polish).

---

## Notes

- `[P]` tasks = different files, no dependencies on incomplete tasks in the same phase.
- `[Story]` label maps each task to a specific user story for traceability.
- Each user story is independently completable and testable; quickstart.md sections map 1:1 to acceptance criteria from spec.md.
- T006 and T007 modify the same file (`src/services/apiKeyService.js`) but different functions — they can be combined in one editing session to keep diff coherent. Same for T013/T014 (different functions in the same file `src/routes/admin.js`).
- Avoid: splitting the booster-pack branch in `recordUsageWithDetails` from the main branch — both must use `ratedCost` together.
- Optional tests (T022, T023) are off the critical path. Skip if you prefer manual verification, or add them for regression confidence.
