# Research — Model Pricing (模型价格)

**Feature**: 001-model-pricing
**Phase**: 0 (Outline & Research)
**Status**: Complete — no `[NEEDS CLARIFICATION]` markers in `spec.md`; `/speckit.clarify` confirmed no critical ambiguities.

This document records the architectural decisions for the feature. Because the spec was written against an existing reference implementation (the `main` branch), most decisions are not "research outcomes" but recorded choices for traceability — i.e. why we are doing it this way, and what alternatives we considered and rejected.

---

## R1. Read-only admin UI; no in-product price editing

**Decision**: The admin tab is read-only. Per-model prices are sourced exclusively from the upstream JSON file (`data/model_pricing.json` + bundled fallback). No "edit price" form, no per-model override.

**Rationale**: Pricing is a downstream-of-truth concern (model providers publish their prices). Letting admins hand-edit them in-product invites stale, divergent, hard-to-audit state. Per-account or per-API-Key economic adjustments are already handled by the separate Service Multiplier feature (`001-service-multiplier`), which composes multiplicatively over the upstream price.

**Alternatives considered**:

- *Editable per-model prices*: Rejected — duplicates the role of Service Multiplier, complicates audit, and creates confusion about which value the cost calculator uses.
- *Per-model overrides on a separate tab*: Rejected — same overlap with Service Multiplier and not requested.

---

## R2. Three admin endpoints under `/admin/models/pricing`

**Decision**: Mirror the `main` branch URL shape exactly:

- `GET /admin/models/pricing` → returns the full in-memory catalog as a JSON object keyed by model name.
- `GET /admin/models/pricing/status` → returns `{ initialized, lastUpdated, modelCount, nextUpdate }`.
- `POST /admin/models/pricing/refresh` → triggers `pricingService.forceUpdate()` and returns `{ success, message }`.

**Rationale**: Operators may already have runbooks, dashboards, or monitoring that hits these URLs against the `main` branch. Preserving the URL shape lets those tools work against `dave` without modification. The shape also matches the SPA's pre-existing assumptions (the main-branch `ModelPricingSection.vue` calls these exact paths).

**Alternatives considered**:

- *Single `GET /admin/pricing` returning catalog + status together*: Rejected — admin SPA loads them in parallel for UX speed; combining couples the cheap status response (a few hundred bytes) to the expensive catalog response (~1 MB) and prevents independent caching at the HTTP layer if it is ever needed.
- *Different URL prefix (e.g. `/admin/pricing/...`)*: Rejected — diverges from `main` for no benefit.

---

## R3. SPA component layout: `components/settings/ModelPricingSection.vue`

**Decision**: Add a new component at `web/admin-spa/src/components/settings/ModelPricingSection.vue`. Introduce a new `components/settings/` folder (does not currently exist on `dave`).

**Rationale**: Mirrors the `main` branch's organization. Provides a natural home for future Settings-section components if the existing in-line markup in `SettingsView.vue` (currently hosting branding / webhook / serviceRates inline) is later extracted for size reasons. The just-shipped `001-service-multiplier` left those sections inline; this feature does not retroactively extract them but plants the convention.

**Alternatives considered**:

- *Inline in `SettingsView.vue`* (matching the existing `serviceRates` tab): Rejected — the table + filter + sort logic is large enough (~350 lines tracking the main-branch shape) that inlining it would push `SettingsView.vue` past 2.5k lines and obscure unrelated diffs.
- *Place under `components/admin/`*: Rejected — `components/admin/` is already populated with `ChangeRoleModal.vue` and `UserUsageStatsModal.vue` which are user-management concerns; a Settings-tab body is a different concern.

---

## R4. Reuse `pricingService.forceUpdate()` as-is for manual refresh

**Decision**: The new refresh endpoint calls `pricingService.forceUpdate()` and returns its `{ success, message }` shape unchanged. No additional concurrency control (queueing, deduplication, mutex).

**Rationale**: `pricingService.forceUpdate()` already implements graceful failure: on download failure it logs the error, calls `useFallbackPricing()`, and returns `{ success: false, message: '<reason>' }`. Two concurrent admin clicks will result in two `https.get` calls — both will succeed or both will fail; either way, the in-memory catalog is replaced atomically by JS reference assignment when each download finishes. Last-write-wins is acceptable: the data is the same per-token-cost JSON regardless of which download completes last. This matches `main`'s behavior. The client-side button-disable in FR-011 already prevents one admin from double-clicking; cross-admin races are sufficiently rare that more elaborate control would be over-engineering.

**Alternatives considered**:

- *Server-side mutex (only one in-flight refresh at a time)*: Rejected — adds complexity for a benefit not observable to users.
- *Queue + dedupe (pin successive callers to one in-flight promise)*: Rejected — same.

---

## R5. No HTTP-level caching (`Cache-Control`) on the catalog response

**Decision**: The `GET /admin/models/pricing` response has no `Cache-Control` header (defaults to `no-store` from Express).

**Rationale**: This is an admin-only endpoint accessed by a single admin operator at a time. Latency is dominated by the catalog payload size (~1 MB), not by request rate. Freshness matters more than bandwidth — when an admin refreshes, they want to see the new catalog immediately, not a cached browser copy. `pricingService.pricingData` is already an in-memory pointer; reading it costs microseconds.

**Alternatives considered**:

- *`Cache-Control: private, max-age=30`*: Rejected — would mask the effect of a successful manual refresh until the cache window expires.
- *`Cache-Control: public, max-age=N`*: Rejected — admin-only data; `public` would be wrong even though the data itself is non-sensitive.

---

## R6. Lazy-load on first tab activation; no auto re-fetch on revisit

**Decision**: Use the existing `SettingsView.vue` lazy-load pattern (`*Loaded` ref + `sectionWatcher`). On first activation of the `modelPricing` tab, fetch the catalog and status in parallel; on subsequent activations within the same SPA session, show the cached in-component state without re-fetching. A successful refresh updates the cached state; a failed refresh leaves it unchanged.

**Rationale**: Consistent with the just-shipped `serviceRates` tab and the existing `branding` / `webhook` tabs. Re-fetching on every tab activation would incur a ~1 MB transfer for no functional benefit (the operator can press 立即刷新 if they want fresh data). The pricing catalog changes at most a few times per week in practice.

**Alternatives considered**:

- *Re-fetch on every tab activation*: Rejected — large payload, no benefit.
- *Re-fetch with stale-while-revalidate semantics*: Rejected — over-engineered for an operator-driven, low-frequency surface.

---

## R7. Audit-log the manual refresh with admin username

**Decision**: Emit `logger.info('✅ Pricing data refreshed by ${adminUsername} — ${result.message}')` on success and `logger.error('❌ Pricing refresh failed:', error)` on hard failure. On `forceUpdate()` returning `success: false` (download failed but fallback succeeded), emit a `warn` with the reason.

**Rationale**: Matches the project pattern just established in `src/routes/admin/serviceRates.js` (`logger.info('✅ Service rates updated by ${adminUsername}')`). Operators investigating an unexpected pricing change can grep the logs for the responsible admin. Failure logs help diagnose upstream-source outages.

**Alternatives considered**:

- *No audit log*: Rejected — operator visibility is required by Constitution Principle IV (Observability).
- *Separate audit-log Redis stream*: Rejected — over-engineered; Winston file logs are sufficient and consistent with the rest of the project.

---

## R8. No public unauthenticated endpoint for pricing

**Decision**: Pricing data is exposed only via the three admin endpoints. No `/apiStats/...` mirror.

**Rationale**: `main` does not expose one. The data is non-sensitive in principle (per-token costs are public information from each provider), but exposing it without auth has no current consumer and would create a new public surface to maintain (rate limiting, abuse handling, monitoring). Out of scope per spec; can be revisited if a downstream pricing-page or transparency requirement emerges.

**Alternatives considered**:

- *`GET /apiStats/pricing` (public, read-only)*: Rejected — out of scope per spec; no current consumer.

---

## R9. Catalog payload — pass-through of upstream JSON shape

**Decision**: The `GET /admin/models/pricing` response body is `{ success: true, data: <pricingService.pricingData> }`, where `<pricingService.pricingData>` is the upstream JSON object keyed by model name with whatever per-model fields the upstream source provides (`input_cost_per_token`, `output_cost_per_token`, `cache_creation_input_token_cost`, `cache_read_input_token_cost`, `max_tokens`, `max_output_tokens`, plus any other fields).

**Rationale**: The SPA owns the per-million conversion (multiply by 1e6) and the missing-field rendering (`-` instead of `$0`). Pushing the conversion to the backend would (a) duplicate logic vs. the cost calculator which uses per-token internally, and (b) lose information on fields the upstream adds in future versions of the pricing JSON. Pass-through preserves forward compatibility for free.

**Alternatives considered**:

- *Backend transforms to per-million-token shape*: Rejected — duplicates conversion logic, loses unknown upstream fields.
- *Backend filters to only known fields*: Rejected — same reason; would silently drop new fields the operator should see.

---

## R10. Provider-name detection in the SPA

**Decision**: Provider hint (`Anthropic` / `Google` / `OpenAI` / `DeepSeek` / `Meta` / `Mistral` / blank) is computed in the SPA from the model name via a small `detectProvider(name)` helper, matching the `main`-branch `ModelPricingSection.vue` implementation.

**Rationale**: The pricing JSON does not carry an explicit provider field. Inferring on the client keeps the backend dumb (pass-through) and lets the UI stay forward compatible with new providers — extending the helper is a one-line change. Same logic powers the platform-tab filter (FR-009).

**Alternatives considered**:

- *Backend annotates each entry with a provider field*: Rejected — duplicates detection logic, couples backend deploys to UI taxonomy changes.
- *Read provider from upstream JSON*: Rejected — the field does not exist.
