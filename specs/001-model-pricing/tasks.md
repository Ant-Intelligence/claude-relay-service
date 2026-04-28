---
description: "Task list for Model Pricing (模型价格) — feature 001-model-pricing"
---

# Tasks: Model Pricing (模型价格)

**Input**: Design documents from `/specs/001-model-pricing/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are NOT requested in the spec. A small set of optional smoke tests is included in the Polish phase; skip those if the team prefers to rely on manual verification via `quickstart.md`.

**Organization**: Tasks are grouped by user story (US1 P1 → US2 P2 → US3 P3) so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label — only applied to story-phase tasks
- All file paths are absolute or rooted at the repository (`/Users/linwang/src/github/xiluo/claude-relay-service`)

## Path Conventions

- Backend: `src/routes/admin/`, `src/routes/admin.js`
- Frontend (Vue 3 SPA): `web/admin-spa/src/views/`, `web/admin-spa/src/components/settings/`, `web/admin-spa/src/config/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: This is an extension to an existing project, so Setup is minimal.

- [X] T001 Verify dev environment runs cleanly: `npm install && npm run dev` brings the API up and the SPA loads at `/admin-next/`; the existing `pricingService` initializes (`logs/claude-relay-*.log` shows `💰 Pricing service initialized successfully`); `data/model_pricing.json` exists or the bundled `resources/model-pricing/model_prices_and_context_window.json` fallback is loaded; admin login works. Document any environment quirks in `specs/001-model-pricing/quickstart.md` if encountered.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The new admin sub-router and the SPA HTTP-client helpers must exist before any user story can wire its UI to real endpoints. All three user stories depend on these three tasks.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Create `src/routes/admin/modelPricing.js` exposing all three endpoints documented in `contracts/admin-model-pricing.openapi.yaml`, all guarded by the existing `authenticateAdmin` middleware:
  - `GET /models/pricing` — if `pricingService.pricingData` is null or empty, defensively await `pricingService.loadPricingData()` first; then return `{ success: true, data: pricingService.pricingData }`. On unexpected error, respond `500` with `{ error, message }`.
  - `GET /models/pricing/status` — return `{ success: true, data: pricingService.getStatus() }`. Reads in-memory state only; never throws.
  - `POST /models/pricing/refresh` — call `await pricingService.forceUpdate()` and return `{ success: result.success, message: result.message }` (HTTP `200` regardless, so the SPA toast can handle `success: false` gracefully). On success, emit `logger.info('✅ Pricing data refreshed by ${req.admin?.username || "admin"} — ${result.message}')`. On unexpected throw, respond `500` with `{ error, message }` and log via `logger.error`.
  - Module style: Express `Router()`, mirroring the just-shipped `src/routes/admin/serviceRates.js` shape.
- [X] T003 Mount the new sub-router from `src/routes/admin.js` (e.g. add `router.use('/', require('./admin/modelPricing'))` near the existing `serviceRatesRoutes` mount around line 51). Depends on T002.
- [X] T004 [P] ~~Add three HTTP-client helpers to `web/admin-spa/src/config/api.js`~~ — **Reframed**: dave's convention (per the just-shipped serviceRates tab) is to call `apiClient.get/post('/admin/...')` inline from the consumer. No per-endpoint helpers needed. The new component uses `apiClient` directly.

**Checkpoint**: The three admin endpoints return real data when called via `curl` with a valid admin session, and the SPA HTTP client compiles. User story implementation can now begin.

---

## Phase 3: User Story 1 — Browse the model price catalog (Priority: P1) 🎯 MVP

**Goal**: Admin opens System Settings → 模型价格 and sees a status card (model count + last-updated timestamp) plus a sortable, searchable table of every model's per-million-token prices and context window.

**Independent Test**: Admin opens the new tab, sees `模型总数: N` and `上次更新: <timestamp>`, plus a populated table; typing `claude` filters rows; clicking the 输入 $/MTok header sorts by ascending input price (clicking again reverses).

### Implementation for User Story 1

- [X] T005 [P] [US1] Create `web/admin-spa/src/components/settings/ModelPricingSection.vue` (NEW FILE; introduces the `components/settings/` directory). Initial scope covers the MVP:
  - Status card with model count and `上次更新: <toLocaleString('zh-CN')>` (or "未知" when null) — matches FR-006 and the `data-model.md` E2 wire shape.
  - Table with one row per model and columns: 模型名称 (with provider hint via a small `detectProvider(name)` helper per `research.md` R10), 输入 $/MTok, 输出 $/MTok, 缓存创建 $/MTok (md+ breakpoint), 缓存读取 $/MTok (md+ breakpoint), 上下文窗口 (lg+ breakpoint).
  - Free-text `searchQuery` input with case-insensitive substring match (FR-008).
  - Clickable column headers for 模型名称 / 输入 / 输出 with ascending/descending indicator (FR-010).
  - `formatPrice()` helper: missing/zero values render as `-`, otherwise multiply by `1e6` and apply the precision rules from FR-013 (≤4 dp under $0.01, ≤3 dp under $1, otherwise 2 dp).
  - `formatContext()` helper: `max_tokens` then `max_output_tokens` then `-`; render `K` / `M` per FR-014.
  - `loadData()` calling the two GET helpers from T004 in parallel (`Promise.all`), populating `pricingData` and `pricingStatus` reactive refs; show a loading spinner while in flight; surface failures via the existing `showToast` utility.
  - `onMounted(loadData)` so the data fetches on first render of the section.
  - "显示 X / Y" counter line beneath the table reflecting filtered vs. total (FR-008 cross-check).
  - All styling MUST include `dark:` variants and responsive breakpoints (FR-016).
  - Leave the platform tabs (US2) and the 立即刷新 button (US3) out of this initial scope — they are added incrementally below.
- [X] T006 [US1] Wire the new section into `web/admin-spa/src/views/SettingsView.vue`. Implementation note: lazy-mount via `<ModelPricingSection v-if="modelPricingMounted" />` guarded by a `modelPricingMounted` ref that flips to `true` in `sectionWatcher` on first activation and stays `true` thereafter (one-shot mount, cached state on revisit per FR-015 / R6).
  - Add a new tab button mirroring the existing branding / webhook / serviceRates pattern (around lines 18 / 30 / 42) bound to `activeSection === 'modelPricing'`.
  - Add a new `<div v-show="activeSection === 'modelPricing'">` rendering `<ModelPricingSection />` (import the component from `@/components/settings/ModelPricingSection.vue`).
  - Lazy-load on first activation by extending the existing `sectionWatcher` (around line 1542) with a `modelPricing` branch — note that since `ModelPricingSection.vue` calls `loadData()` from its own `onMounted`, the watcher branch can simply be a no-op or omitted entirely as long as the section is mounted only when active. Choose whichever matches the existing pattern most cleanly.
  - Depends on T005 (component must exist before it can be imported).

**Checkpoint**: User Story 1 is fully functional. Walk quickstart.md sections 1, 2, 3, 4 to validate.

---

## Phase 4: User Story 2 — Filter by upstream platform (Priority: P2)

**Goal**: Admin clicks platform tabs (全部 / Claude / Gemini / OpenAI / 其他) to narrow the table to a single provider family.

**Independent Test**: With the table loaded, click `Gemini`; only Gemini-family rows remain. Click `OpenAI`; rows match `gpt-*`, `o1-*`, `o3-*`, `o4-*`, or `codex*`. Compose with search: with `Gemini` active, type `flash`; only Gemini-family models containing "flash" remain.

### Implementation for User Story 2

- [X] T007 [US2] Extend `web/admin-spa/src/components/settings/ModelPricingSection.vue` to add platform tabs and filter logic. Delivered together with T005 in a single component file (the platform tabs + `detectProvider()` + composed `filteredModels` are baked into the initial component).
  - `platformTabs` array `[{ key: 'all', label: '全部' }, { key: 'claude', label: 'Claude' }, { key: 'gemini', label: 'Gemini' }, { key: 'openai', label: 'OpenAI' }, { key: 'other', label: '其他' }]`.
  - `activePlatform` reactive ref defaulting to `'all'`.
  - Tab buttons rendered above the table next to (or alongside) the search input; active tab styled distinctly.
  - `filteredModels` computed property composing platform filter + `searchQuery` (matches the AC-2 requirement that filters compose).
  - Platform filter predicates per FR-009 / `research.md` R10:
    - `claude` → name contains `"claude"`.
    - `gemini` → name contains `"gemini"`.
    - `openai` → name contains any of `"gpt"`, `"o1"`, `"o3"`, `"o4"`, `"codex"`.
    - `other` → none of the above.
  - The "显示 X / Y" counter MUST reflect the post-platform-filter, post-search count.
  - Dark-mode + responsive styling on the tab buttons.
  - Depends on T005.

**Checkpoint**: User Story 2 is fully functional. Walk quickstart.md section 5 to validate.

---

## Phase 5: User Story 3 — Manually refresh from upstream (Priority: P3)

**Goal**: Admin clicks 立即刷新; the SPA calls `POST /admin/models/pricing/refresh`; on success the status card and table reflect the fresh data; on failure the previous catalog is preserved and an error toast surfaces.

**Independent Test**: Click 立即刷新; success toast appears, 上次更新 advances to "just now". Then point the upstream URL at an unreachable host, click again; error toast surfaces, 上次更新 does NOT advance, the table remains populated.

### Implementation for User Story 3

- [X] T008 [US3] Extend `web/admin-spa/src/components/settings/ModelPricingSection.vue` to add the 立即刷新 button and handler. Delivered together with T005/T007 in the single component file (status-card 立即刷新 button + `handleRefresh()` + `refreshing` ref are baked in).
  - Add a 立即刷新 button to the status card (right side); disable while `refreshing === true` and show a spinner + label "刷新中..." (FR-011).
  - `refreshing` reactive ref, defaulting to `false`.
  - `handleRefresh()` async function:
    - Set `refreshing = true`.
    - Call `refreshAdminModelPricingApi()` from T004.
    - On `result.success === true`: success toast (e.g. "价格数据已刷新"), then `await loadData()` to re-fetch catalog + status.
    - On `result.success === false` or HTTP error: error toast surfacing `result.message` verbatim if present, otherwise a generic failure message (FR-012). Do NOT re-fetch; the previous catalog stays put per `data-model.md` E3 guarantees.
    - In `finally`, set `refreshing = false`.
  - Depends on T005.

**Checkpoint**: User Story 3 is fully functional. Walk quickstart.md sections 6 and 7 to validate.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Quality gates and verification across all stories. Optional smoke tests live here.

- [X] T009 [P] Run `npx prettier --write` on every modified file (backend and SPA). Backend file: prettier ran from repo root. SPA files: prettier ran from `web/admin-spa/` (where the `prettier-plugin-tailwindcss` plugin is installed). All four touched files reported clean.
- [X] T010 [P] Run `npm run lint` and resolve any new errors introduced by US1–US3 work. Both `npm run lint` (backend) and `web/admin-spa/ npm run lint` (SPA) returned zero errors.
- [ ] T011 [P] **(Optional)** Add a SuperTest integration test in `tests/integration/modelPricing.test.js` covering: (a) all three endpoints return `401` without admin auth, (b) `GET /admin/models/pricing` returns a non-empty catalog when `pricingService` is initialized, (c) `GET /admin/models/pricing/status` returns the documented shape with `initialized: true`, (d) `POST /admin/models/pricing/refresh` returns `{ success: boolean, message: string }` regardless of upstream availability.
- [ ] T012 [P] **(Optional)** Add a Jest unit test in `tests/unit/services/pricingService.test.js` covering: `getStatus()` shape and field semantics (especially `nextUpdate = lastUpdated + updateInterval`), and `forceUpdate()` returning `success: false` with a meaningful message when the upstream URL is unreachable.
- [X] T013 Walked all 8 sections of `quickstart.md` against a local dev instance (port 8080) via Chrome DevTools MCP. Results: §1 tab+status card render (219 models, timestamp displayed) ✓; §2 per-MTok arithmetic verified on `claude-sonnet-4-5` ($3/$15/$3.75/$0.30, 64K) and missing-field `-` rendering on `gpt-5` cache create ✓; §3 search "claude" → 27/219 ✓; §4 input-column sort toggles ASC↔DESC with correct indicator and row reorder ✓; §5 Gemini-only filter → 67 rows, Gemini+search "flash" → 33 rows, "其他" → 3 DeepSeek rows ✓; §6 successful refresh advanced timestamp 14:36:11→14:41:45, server log `✅ Pricing data refreshed by admin — Pricing data updated successfully` (750ms) ✓; §7 simulated upstream outage (invalid.example.invalid) — server logged `⚠️ Pricing refresh by admin fell back to bundled data — Download failed: ...` (1260ms, HTTP 200, WARN level), client timestamp UNCHANGED, row count 219 preserved ✓; §8 dark-mode + responsive verified via DOM/computed-style inspection at 1280/768/500 px (chrome floor) ✓. Zero console errors/warnings throughout. `config/pricingSource.js` restored.
- [X] T014 [P] Dark-mode and responsive verification baked into T013 §8: column visibility correctly toggles via `md:table-cell` / `lg:table-cell` (cache cols hide below 768 px, context col hides below 1024 px); `dark:` variants resolve to the expected gray-700/800/900 palette with high-contrast row text. Refresh button (111×36 px) and search input remain tappable at 500 px.
- [X] T015 FR-018 backward-compat confirmed during T013 §7: with the upstream pricing source unreachable, `pricingService.forceUpdate()` fell back to bundled pricing without zeroing the in-memory catalog. The cost-calculation pipeline (which reads `pricingService.getModelPricing(model)`) was never blocked or interrupted; subsequent admin GET on `/admin/models/pricing` returned the preserved 219-model catalog (HTTP 200, 12 ms).
- [X] T016 Final PR checklist: Constitution Check (plan.md) still passes (no design changes since the gate evaluation); `CLAUDE.md` already updated by `/speckit.plan` via `update-agent-context.sh claude`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion. **Blocks all user stories.**
- **User Stories (Phase 3+)**: All depend on Foundational completion.
  - US1 must ship before US2 and US3 can be merged, because both modify the same `ModelPricingSection.vue` file that US1 creates. (They could in principle be parallel branches off US1's component and rebased before merge — but the simpler sequential path is recommended.)
- **Polish (Phase 6)**: Depends on whichever user stories are being shipped in the current PR.

### User Story Dependencies

- **US1 (P1)**: Depends only on Foundational. **MVP** — read-only browse + status card + search + sort.
- **US2 (P2)**: Depends on Foundational and on T005 (the component file from US1). The platform-tab edits compose with the existing search/sort logic in the same file.
- **US3 (P3)**: Depends on Foundational and on T005. Same file as US1/US2; additive edit (new button + handler).

### Within Each User Story

- Backend route handlers and SPA HTTP-client helpers are already in Foundational.
- Inside US1: T005 (new component) and T006 (SettingsView integration) are sequential — T006 imports the component created by T005.
- Inside US2 and US3: each is a single edit to `ModelPricingSection.vue`.

### Parallel Opportunities

- T002 (new file) and T004 (different file) in Foundational can be done by two devs in parallel; T003 must follow T002.
- All Polish tasks marked `[P]` are file-independent.
- US2 and US3 cannot be done strictly in parallel because they both modify `ModelPricingSection.vue`. If staffed by two developers, one can rebase onto the other before merge.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Two devs in parallel:
Task: "Create src/routes/admin/modelPricing.js (T002)"
Task: "Add HTTP-client helpers to web/admin-spa/src/config/api.js (T004)"

# Then sequential:
Task: "Mount sub-router in src/routes/admin.js (T003)"
```

## Parallel Example: User Story 1

```bash
# T005 standalone (new file), then T006 follows:
Task: "Create web/admin-spa/src/components/settings/ModelPricingSection.vue (T005)"
Task: "Add 模型价格 tab + section in SettingsView.vue (T006)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001).
2. Complete Phase 2: Foundational (T002, T003, T004).
3. Complete Phase 3: User Story 1 (T005, T006).
4. **STOP and VALIDATE**: walk through quickstart.md sections 1–4.
5. Ship — operators can now inspect the live pricing catalog used for billing.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. + US1 → MVP shipped (browse + search + sort).
3. + US2 → platform filter available.
4. + US3 → manual refresh available.
5. + Polish → format / lint / quickstart walk-through / optional smoke tests.

### Single-PR Delivery (recommended for this small surface)

Because every code change is small (one new backend file, three small additions to the SPA, sequential edits to one component), a single PR delivering all three stories is realistic. Sequence:

1. T001 → T002 → T003 → T004 (one or two commits).
2. T005 → T006 (US1 frontend; one commit).
3. T007 (US2 platform filter; one commit).
4. T008 (US3 refresh; one commit).
5. T009 → T010 → T013 → T014 → T015 → T016 (polish).
6. Optional: T011 / T012 (smoke tests) if the team wants regression confidence.

---

## Notes

- `[P]` tasks = different files, no dependencies on incomplete tasks in the same phase.
- `[Story]` label maps each task to a specific user story for traceability.
- Each user story is independently completable and testable; quickstart.md sections map 1:1 to acceptance criteria from spec.md.
- T005, T007, T008 all modify the same file (`ModelPricingSection.vue`). They are listed sequentially in story-priority order; the diffs do not conflict because each task adds a distinct, additive concern (table+search+sort → platform tabs → refresh button).
- Backend changes (T002, T003, T004) are pure additions — no existing endpoints, services, or shared utilities are modified. Low regression risk.
- Optional tests (T011, T012) are off the critical path. Skip if the team prefers manual verification, or add them for regression confidence per Constitution Principle IV (Observability) → Principle V (Spec-Driven Development) trade-off.
