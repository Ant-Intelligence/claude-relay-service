# Implementation Plan: Service Multiplier (服务倍率)

**Branch**: `001-service-multiplier` | **Date**: 2026-04-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-service-multiplier/spec.md`

## Summary

Re-implement the `main` branch's "服务倍率 (Service Multiplier)" feature natively on the `dave` branch. Administrators configure a per-service multiplier (Claude / Codex / Gemini / Droid / Bedrock / Azure / CCR) via a new tab in **System Settings → 服务倍率**. The multiplier is composed multiplicatively with an optional per-API-Key override and applied to the calculated USD cost of every request: `ratedCost = realCost × globalRate × keyOverrideRate`. Quotas (daily / weekly / total cost) deduct only `ratedCost`; admin-side audit views still see `realCost`. A small public read-only endpoint exposes the rate map (without `updatedBy`) for downstream pricing pages.

The technical approach reuses the existing `apiKeyService.recordUsage` / `recordUsageWithDetails` integration points, introduces one new service module (`serviceRatesService.js`), one new admin route module (`src/routes/admin/serviceRates.js`), one new public endpoint on `apiStats.js`, a single new Redis key (`system:service_rates`), and a new optional JSON field (`serviceRates`) on the existing `api_key:{id}` hash. The frontend extends `SettingsView.vue` with a new tab and `ApiKeyForm` (within `ApiKeysView`) with a new "Service Rate Overrides" section.

## Technical Context

**Language/Version**: Node.js 18+ (ES2020+) for backend; Vue 3 + Vite for the admin SPA.
**Primary Dependencies**: Express.js 4.18.2, ioredis 5.3.2, axios 1.6.0, winston 3.11.0 (all existing); Vue 3, Pinia, Tailwind CSS, Font Awesome (admin SPA, all existing). No new runtime dependencies.
**Storage**: Redis (ioredis client). One new key `system:service_rates` (hash or JSON string) and one new optional field `serviceRates` on the existing `api_key:{id}` hash.
**Testing**: Jest + SuperTest (existing project test stack). Manual verification via the admin SPA + targeted API smoke tests as described in `quickstart.md`.
**Target Platform**: Linux server (Docker Compose deployment), Node.js 18+ runtime, Redis 6+.
**Project Type**: Web service with Express.js backend + Vue 3 SPA frontend (existing dual-tree layout under `src/` and `web/admin-spa/`).
**Performance Goals**: Multiplier lookup adds ≤ 1 ms p99 to the request hot path (in-memory cache, 60s TTL). Admin SPA tab loads in < 2 s on baseline production env (SC-004).
**Constraints**: Backward compatible — pre-feature usage records lack `ratedCost` and MUST be treated as `ratedCost == realCost` by readers. Hot path MUST fail open on config-store read errors (FR-019). All sensitive admin endpoints behind existing `authenticateAdmin` middleware. SPA additions MUST support dark mode and responsive breakpoints (FR-018).
**Scale/Scope**: One global config record (≤ 7 service entries × 8 bytes); per-key override is a small JSON object (≤ 7 entries) on at most a few thousand API keys. No new fan-out, no new schedulers, no new external API calls. Hot-path lookup is O(1) from in-memory cache.

## Constitution Check

*Constitution version 1.0.0 (Ratified 2026-02-16). Each gate evaluated below.*

| Principle | Compliance | Notes |
|-----------|------------|-------|
| I. Security First | ✅ Pass | Admin endpoints reuse the existing `authenticateAdmin` middleware. Public endpoint exposes only non-sensitive fields (`rates`, `baseService`, `updatedAt`); `updatedBy` is admin-only (FR-011). No new credentials are stored, so AES encryption requirements do not apply to this feature. API Key SHA-256 hashing is unchanged. |
| II. Service Modularity | ✅ Pass | New logic isolated in `src/services/serviceRatesService.js`; new HTTP surface in `src/routes/admin/serviceRates.js`. No cross-platform code is duplicated; service detection helper sits next to the new service. The change to `apiKeyService.recordUsage*` is a thin call-site addition, not a new abstraction. |
| III. Backward Compatibility | ✅ Pass | All existing endpoints (`/api/v1/messages`, `/openai/v1/chat/completions`, etc.) keep their request/response shape. Pre-feature usage records lack `ratedCost`; readers fall back to `realCost` so historical data is unaffected (FR-016). When no admin has saved rates, behavior is identical to today (every multiplier defaults to 1.0). |
| IV. Observability | ✅ Pass | Winston logs are emitted on (a) successful admin saves with `updatedBy`, (b) hot-path config-read failures (warning, fail-open), (c) malformed per-key override (warning, fall back). Both `realCost` and `ratedCost` are persisted on usage records for full audit trail. |
| V. Spec-Driven Development | ✅ Pass | This plan follows `specify → plan → tasks → implement`. Spec lives at `specs/001-service-multiplier/spec.md` with prioritized P1/P2/P3 user stories, acceptance scenarios, and Clarifications session 2026-04-28. |
| VI. Simplicity & Minimal Change | ✅ Pass | One new service file, one new admin route file, one new function on `apiStats.js`, one in-memory cache (60 s TTL). No feature flags, no compatibility shims beyond the trivial "missing rate ⇒ 1.0" defaulting that is core to the feature. No new abstractions. |
| VII. Resilience & Fault Tolerance | ✅ Pass | Hot path fails open on read errors (FR-019). Per-key override JSON parse failures degrade to "no override" with a warning (FR-017). Cache TTL bounded to 60 s so misconfiguration self-heals quickly (FR-012). No long-lived connections introduced. |

**Result**: All 7 principles pass. No entries needed in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-service-multiplier/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # /speckit.specify output (already present)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── admin-service-rates.openapi.yaml    # Admin REST contract
│   └── public-service-rates.openapi.yaml   # Public read endpoint contract
├── checklists/
│   └── requirements.md  # /speckit.specify quality checklist (already present)
└── tasks.md             # /speckit.tasks output (NOT created here)
```

### Source Code (repository root, dave branch)

```text
src/
├── services/
│   ├── serviceRatesService.js         # NEW — global config CRUD, in-memory cache, service detection,
│   │                                  #       composition formula, fail-open hot-path read
│   ├── apiKeyService.js               # MODIFY — recordUsage / recordUsageWithDetails: compute ratedCost
│   │                                  #       and pass to redis.incrementDailyCost / incrementWeeklyCost /
│   │                                  #       incrementTokenUsage / addUsageRecord; also surfaces both
│   │                                  #       costs on admin-only stats responses, ratedCost-only on
│   │                                  #       key-facing responses (FR-009a)
│   └── …                              # (unchanged)
├── routes/
│   ├── admin/
│   │   └── serviceRates.js            # NEW — GET /admin/service-rates,
│   │                                  #       PUT /admin/service-rates,
│   │                                  #       GET /admin/service-rates/services
│   ├── admin.js                       # MODIFY — register the new admin sub-router AND extend the
│   │                                  #       Create/Edit API Key endpoints (POST /admin/api-keys,
│   │                                  #       PUT /admin/api-keys/:keyId) to accept and persist the
│   │                                  #       optional `serviceRates` field on the api_key hash
│   ├── apiStats.js                    # MODIFY — add GET /apiStats/service-rates (public, no auth)
│   └── …                              # (unchanged)
├── models/
│   └── redis.js                       # MODIFY (small) — add helpers getServiceRates / setServiceRates;
│                                      #       extend addUsageRecord to persist ratedCost alongside
│                                      #       cost (cost stays = realCost for backward compat)
└── utils/
    └── …                              # (no new utils; service detection lives in serviceRatesService)

web/admin-spa/src/
├── views/
│   ├── SettingsView.vue               # MODIFY — add new tab "服务倍率" with grid of service cards
│   └── ApiKeysView.vue                # MODIFY — extend Create/Edit form with optional
│                                      #          "Service Rate Overrides" section
├── components/
│   └── apikeys/
│       └── ApiKeyForm.vue             # MODIFY (or whichever component owns the form) — same as above
├── stores/
│   └── …                              # (no new stores; local refs in SettingsView suffice)
└── utils/
    └── http_apis.js (or equivalent)   # MODIFY — add getAdminServiceRatesApi /
                                       #          updateAdminServiceRatesApi /
                                       #          getPublicServiceRatesApi calls
```

**Structure Decision**: The repository is a single-tree Node.js service with an embedded Vue 3 SPA. We extend it in place — no new top-level directories. Backend additions live under `src/services/` and `src/routes/admin/`; frontend additions live under `web/admin-spa/src/views/` and `web/admin-spa/src/components/apikeys/`. This matches the constitution's "Service Modularity" and "Simplicity & Minimal Change" principles.

## Phase 0: Outline & Research

Phase 0 verifies all open technical questions are resolved before design. The spec's clarifications (session 2026-04-28) closed every product-level NEEDS CLARIFICATION; this phase resolves remaining engineering questions about how the dave-branch surface differs from main and which dave-branch APIs the new code should call. Output: `research.md` (created in this phase).

Key research items:

1. **Hot-path integration point** — confirm `apiKeyService.recordUsage` *and* `apiKeyService.recordUsageWithDetails` are the only call sites where cost is recorded in dave (grep confirmed: yes; both call `redis.incrementDailyCost`, optionally `redis.incrementWeeklyCost`, and `redis.incrementTokenUsage` with the cost arg, plus `redis.addUsageRecord`).
2. **Service detection on dave** — map dave's account-type strings to multiplier service IDs: `claude-official` / `claude-console` / `ccr` → `claude` (note: `ccr` has its own bucket per spec; treat ccr as `ccr`); `bedrock` → `bedrock`; `gemini` / `gemini-api` → `gemini`; `openai` / `openai-responses` → `codex`; `azure-openai` → `azure`; `droid` → `droid`. Per Q3 in spec.
3. **Per-key override storage shape** — store as a JSON-stringified `{service: number}` object in the existing `api_key:{id}` hash under field name `serviceRates`; missing or malformed JSON → no override, warning logged.
4. **Cache strategy** — single in-memory `Map`-backed cache in `serviceRatesService` with timestamped expiry (60 s TTL). Save invalidates the cache. No distributed invalidation needed because TTL is short.
5. **Public endpoint placement** — mount on existing `apiStats.js` router (already public), at path `/apiStats/service-rates`.
6. **Backwards-compat for usage records** — readers (admin stats endpoints) MUST treat absence of `ratedCost` field as `ratedCost == realCost`. No data migration required.
7. **SPA tab pattern** — `SettingsView.vue` already uses `activeSection` ref + matching `<button>`/`<div v-show>` pattern (confirmed at lines 18, 22, 30, 34, 51, 373, 1234). New tab follows the same pattern.

**Output**: `research.md` with one Decision/Rationale/Alternatives entry per item above.

## Phase 1: Design & Contracts

**Prerequisites**: `research.md` complete.

### 1. Data Model → `data-model.md`

Two persisted entities + one logical entity:

- **ServiceRatesConfig** (Redis key `system:service_rates`): single record with `rates: { [service]: number }`, `baseService: string`, `updatedAt: ISO-8601 string`, `updatedBy: string`.
- **ApiKeyServiceRateOverride** (field on `api_key:{id}` hash, name `serviceRates`): JSON-encoded `{ [service]: number }`, optional, defaults to `{}`.
- **UsageRecord (existing, semantically extended)**: now stores both `realCost` and `ratedCost`; quota counters (`incrementDailyCost`, `incrementWeeklyCost`, `usage:cost:total:{keyId}`) consume `ratedCost`.

Validation rules:
- Every value in `rates` and in any override map MUST be a finite, strictly positive number.
- Service IDs MUST be one of `{claude, codex, gemini, droid, bedrock, azure, ccr}`.

### 2. Interface Contracts → `contracts/`

Two OpenAPI-style contracts:

- `contracts/admin-service-rates.openapi.yaml` — describes `GET /admin/service-rates`, `PUT /admin/service-rates`, `GET /admin/service-rates/services`. All require admin auth.
- `contracts/public-service-rates.openapi.yaml` — describes `GET /apiStats/service-rates`. Public, no auth. Payload omits `updatedBy`.

The Create/Edit API Key endpoints (`POST /admin/api-keys`, `PUT /admin/api-keys/:keyId`) are NOT redocumented as new contracts — they continue to be defined where they live today; the only delta is acceptance of an optional `serviceRates` body field. That delta is documented in `data-model.md`.

### 3. Quickstart → `quickstart.md`

A short developer-facing walkthrough: install → run dev → log in as admin → save Gemini=0.5 → make a Gemini API call → verify rated cost in admin stats and key-facing usage endpoint.

### 4. Agent Context Update

Run `.specify/scripts/bash/update-agent-context.sh claude` to refresh `.claude/` agent context with the new service file paths and Redis key. (No new technologies — only file paths.)

**Output**: `data-model.md`, `contracts/admin-service-rates.openapi.yaml`, `contracts/public-service-rates.openapi.yaml`, `quickstart.md`, refreshed agent context file.

## Complexity Tracking

> No Constitution Check violations. This section intentionally left blank.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| (none)    | (n/a)      | (n/a)                                |
