# Implementation Plan: Model Pricing (模型价格)

**Branch**: `001-model-pricing` | **Date**: 2026-04-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-model-pricing/spec.md`

## Summary

Re-implement the `main` branch's "模型价格 (Model Pricing)" admin tab natively on the `dave` branch. Administrators open **System Settings → 模型价格** and see the in-memory pricing catalog used by the cost-calculation pipeline: a status card with the total model count and last-updated timestamp, a "立即刷新" button that triggers a manual remote re-download, plus a sortable / searchable / platform-filterable table of every model with its per-million-token prices (input / output / cache create / cache read) and context-window size.

The technical approach piggybacks on the existing `pricingService` (`src/services/pricingService.js`) which already exposes `pricingData`, `lastUpdated`, `getStatus()`, and `forceUpdate()`, and which is already wired into cost calculation (`src/utils/costCalculator.js`, `src/handlers/geminiHandlers.js`, `src/routes/openaiClaudeRoutes.js`). This feature is purely additive surface: three new admin endpoints (`GET /admin/models/pricing`, `GET /admin/models/pricing/status`, `POST /admin/models/pricing/refresh`), one new SPA component (`ModelPricingSection.vue`), three HTTP-client helpers in `web/admin-spa/src/config/api.js`, and one new tab in `SettingsView.vue`. No new persistent storage, no schema changes, no hot-path modification.

## Technical Context

**Language/Version**: Node.js 18+ (ES2020+) for backend; Vue 3 + Vite for the admin SPA.
**Primary Dependencies**: Express.js 4.18.2, ioredis 5.3.2, axios 1.6.0, winston 3.11.0 (all existing); Vue 3, Pinia, Tailwind CSS, Font Awesome (admin SPA, all existing). No new runtime dependencies.
**Storage**: None new. Reuses the existing `pricingService` in-memory catalog (sourced from `data/model_pricing.json` + bundled fallback at `resources/model-pricing/model_prices_and_context_window.json`).
**Testing**: Jest + SuperTest (existing project test stack). Manual verification via the admin SPA per `quickstart.md`.
**Target Platform**: Linux server (Docker Compose deployment), Node.js 18+ runtime, Redis 6+.
**Project Type**: Web service with Express.js backend + Vue 3 SPA frontend (existing dual-tree layout under `src/` and `web/admin-spa/`).
**Performance Goals**: Pricing tab loads in < 2 s on baseline production env (SC-001). Client-side search + filter on a ~600–1000 row catalog in < 200 ms perceived latency (SC-003). Manual refresh round-trip in < 5 s on success (SC-004).
**Constraints**: MUST NOT alter the cost-calculation hot path (FR-018). Refresh failure MUST preserve the previously loaded catalog (SC-005). Endpoints MUST require admin auth (FR-004). UI MUST support dark mode + responsive breakpoints (FR-016). No new persistent storage (FR-017). No editable per-model prices (FR-019).
**Scale/Scope**: One deployment-wide in-memory catalog (~600–1000 models, JSON ≈ 0.5–1.5 MB). Admin-only feature, low traffic (manual operator usage). No fan-out, no scheduling changes — `pricingService` already handles its own auto-update timer.

## Constitution Check

*Constitution version 1.0.0 (Ratified 2026-02-16). Each gate evaluated below.*

| Principle | Compliance | Notes |
|-----------|------------|-------|
| I. Security First | ✅ Pass | All three new endpoints reuse the existing `authenticateAdmin` middleware (FR-004). No new credentials are stored, so AES encryption requirements do not apply. The catalog itself is non-sensitive (publicly published per-token prices). The refresh endpoint exposes no upstream-source URL or response body to the caller — only `{ success, message }`. |
| II. Service Modularity | ✅ Pass | The new admin sub-router (`src/routes/admin/modelPricing.js`) follows the same pattern as the just-shipped `src/routes/admin/serviceRates.js` and `src/routes/admin/apiKeyRegenerate.js`. The SPA component lives in a new `web/admin-spa/src/components/settings/` folder, mirroring the main-branch layout for cohesion if other Settings-section components are extracted later. No cross-platform service is touched. |
| III. Backward Compatibility | ✅ Pass | All existing endpoints (`/api/v1/messages`, `/openai/v1/chat/completions`, etc.) keep their request/response shape. Cost calculation continues to consume `pricingService.pricingData` exactly as today; this feature only adds read paths over the same data. No Redis schema change, no new key. |
| IV. Observability | ✅ Pass | Manual-refresh handler emits a Winston `info` log with the admin username on success (matching the `serviceRates.js` pattern: `✅ Pricing data refreshed by ${adminUsername}`) and an `error` log on failure. The status endpoint surfaces last-updated and next-update timestamps for operator monitoring. No silent failures. |
| V. Spec-Driven Development | ✅ Pass | This plan follows `specify → plan → tasks → implement`. Spec lives at `specs/001-model-pricing/spec.md` with prioritized P1/P2/P3 user stories, acceptance scenarios, and a passing requirements checklist. |
| VI. Simplicity & Minimal Change | ✅ Pass | One new admin route file (~50 lines), one new SPA component (~350 lines tracking the main-branch shape), three SPA HTTP-client functions, one new tab button + section in `SettingsView.vue`. No new abstractions, no new service module on the backend (we delegate to the already-existing `pricingService`). No feature flags, no compatibility shims. |
| VII. Resilience & Fault Tolerance | ✅ Pass | `pricingService.forceUpdate()` already implements a fallback-to-bundled path on download failure; the refresh endpoint surfaces the failure to the operator without crashing the route or losing the in-memory catalog (FR-018, SC-005). The status endpoint never throws — it reads in-memory state. The catalog endpoint, if called before initialization completes, triggers `loadPricingData()` defensively (matching the main-branch behavior). |

**Result**: All 7 principles pass. No entries needed in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-model-pricing/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # /speckit.specify output (already present)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── admin-model-pricing.openapi.yaml  # Admin REST contract (3 endpoints)
├── checklists/
│   └── requirements.md  # /speckit.specify quality checklist (already present)
└── tasks.md             # /speckit.tasks output (NOT created here)
```

### Source Code (repository root, dave branch)

```text
src/
├── services/
│   └── pricingService.js           # UNCHANGED — already provides pricingData, lastUpdated,
│                                   #             getStatus(), forceUpdate(), loadPricingData()
├── routes/
│   ├── admin/
│   │   └── modelPricing.js         # NEW — GET /models/pricing,
│   │                               #       GET /models/pricing/status,
│   │                               #       POST /models/pricing/refresh
│   ├── admin.js                    # MODIFY — register the new admin sub-router (one-line
│   │                               #          mount alongside the existing serviceRatesRoutes)
│   └── …                           # (unchanged)
└── …                               # (no other backend changes)

web/admin-spa/src/
├── components/
│   └── settings/
│       └── ModelPricingSection.vue # NEW — status card + refresh button + searchable /
│                                   #       sortable / platform-filterable table
├── config/
│   └── api.js                      # MODIFY — add three HTTP-client helpers:
│                                   #          getAdminModelPricingApi,
│                                   #          getAdminModelPricingStatusApi,
│                                   #          refreshAdminModelPricingApi
└── views/
    └── SettingsView.vue            # MODIFY — add 模型价格 tab button (alongside the existing
                                    #          branding / webhook / serviceRates tabs);
                                    #          render <ModelPricingSection /> in the section;
                                    #          extend sectionWatcher with a 'modelPricing'
                                    #          lazy-load branch
```

**Structure Decision**: Reuse the existing dual-tree layout (`src/` for backend, `web/admin-spa/src/` for the SPA). The backend addition is a single new admin sub-router file mounted from `admin.js`, matching the pattern just established by `001-service-multiplier`. The SPA addition introduces a new `components/settings/` folder (does not yet exist on `dave`) so that future extracted Settings-section components have a natural home, consistent with the `main` branch's organization. No new top-level directories.

## Phase 0: Outline & Research

**Output**: [research.md](./research.md)

The spec aggressively pre-resolved the following decisions (no `[NEEDS CLARIFICATION]` markers in `spec.md` and `/speckit.clarify` reported no critical ambiguities). They are recorded in `research.md` as decisions for traceability:

- **R1**: Read-only admin UI (no in-product price editing) — matches `main`; editing is out of scope.
- **R2**: Three admin endpoints `GET /admin/models/pricing`, `GET /admin/models/pricing/status`, `POST /admin/models/pricing/refresh` — matches `main`'s URL shape so any operator runbooks remain usable.
- **R3**: SPA component lives at `web/admin-spa/src/components/settings/ModelPricingSection.vue` — mirrors main; introduces a new `settings/` folder under `components/` since `dave` has no equivalent yet.
- **R4**: Reuse `pricingService.forceUpdate()` for manual refresh; do NOT introduce concurrency control (deduplication / queueing) beyond what the service already provides — two concurrent admin clicks result in two upstream downloads with last-write-wins, matching `main`.
- **R5**: No HTTP-level caching (`Cache-Control`) on the catalog response — admin-only, low-traffic, freshness > bandwidth.
- **R6**: Tab lazy-load on first activation only (per FR-015); revisits show the cached in-component state without re-fetching, matching the existing `branding`/`webhook`/`serviceRates` patterns in `SettingsView.vue` (`*Loaded` ref + `sectionWatcher`).
- **R7**: Audit-log the refresh action with `req.admin.username` at `info` level, matching the project pattern from `serviceRates.js` route.
- **R8**: No public unauthenticated endpoint for pricing — out of scope per spec; admin-only matches `main`.

## Phase 1: Design & Contracts

### Entities → [data-model.md](./data-model.md)

Three read-only logical entities are documented:

- **E1 — Pricing Catalog** (existing, surfaced read-only via the new endpoint).
- **E2 — Pricing Service Status** (existing, surfaced via the new status endpoint).
- **E3 — Refresh Result** (transient response of the new refresh endpoint).

No new persistent storage is introduced; the data-model document defines the wire-shape contract between the backend endpoints and the SPA component, so that the UI can be built and tested against a stable schema even though no DB schema migrations are required.

### Contracts → [contracts/admin-model-pricing.openapi.yaml](./contracts/admin-model-pricing.openapi.yaml)

One OpenAPI 3.0.3 file documenting the three admin endpoints and their schemas. All three are guarded by the existing `authenticateAdmin` middleware. No public contract file is needed (out of scope).

### Quickstart → [quickstart.md](./quickstart.md)

Eight manual verification sections that map 1:1 to the Acceptance Scenarios in `spec.md`:

1. Open the new tab and verify the status card + table render.
2. Verify per-million conversion of prices (sample-row arithmetic).
3. Verify search filters the table.
4. Verify sortable columns work (asc / desc, with indicator).
5. Verify platform tabs (全部 / Claude / Gemini / OpenAI / 其他).
6. Verify successful manual refresh advances `上次更新`.
7. Verify failed manual refresh preserves the prior catalog and shows an error toast.
8. Verify dark-mode + responsive breakpoints (375 / 768 / 1280 px).

### Agent Context Update

The `update-agent-context.sh claude` script will append the new technology context (no new dependencies, but the new feature is registered) to `CLAUDE.md`.

## Complexity Tracking

> Constitution Check passed all 7 gates with no violations. No entries needed.
