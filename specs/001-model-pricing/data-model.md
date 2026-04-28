# Data Model — Model Pricing (模型价格)

**Feature**: 001-model-pricing
**Storage**: None new. The feature is read-only over an existing in-memory + on-disk catalog managed by `pricingService`.

This file documents the wire-shape contract between the new admin endpoints and the SPA component. No Redis keys, no schema migrations, no new persistence.

---

## E1. Pricing Catalog (existing, surfaced read-only)

**Source of truth**: `data/model_pricing.json` (downloaded from `pricingSource.pricingUrl`), with `resources/model-pricing/model_prices_and_context_window.json` as bundled fallback.
**In-memory location**: `pricingService.pricingData` — populated on service startup by `pricingService.initialize()` and refreshed on schedule (24 h) or via manual `forceUpdate()`.
**Cardinality**: One catalog per deployment. ~600–1000 entries on a typical install.

### Wire shape (`GET /admin/models/pricing` → `data` field)

```json
{
  "<modelName>": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_read_input_token_cost": 0.0000003,
    "max_tokens": 200000,
    "max_output_tokens": 8192,
    "...": "any additional upstream fields are passed through unchanged"
  },
  "<anotherModel>": { "...": "..." }
}
```

### Field semantics (per entry)

| Field | Type | Description | Required by SPA |
|-------|------|-------------|-----------------|
| `input_cost_per_token` | number | USD per input token. SPA renders as `value × 1e6` $/MTok. | ✅ |
| `output_cost_per_token` | number | USD per output token. Same conversion. | ✅ |
| `cache_creation_input_token_cost` | number? | USD per cache-write token. Missing/0 → `-` in UI. | optional |
| `cache_read_input_token_cost` | number? | USD per cache-read token. Missing/0 → `-` in UI. | optional |
| `max_tokens` | number? | Total context window. SPA prefers this; falls back to `max_output_tokens`. Missing → `-`. | optional |
| `max_output_tokens` | number? | Output cap (used as fallback for context-window display). | optional |
| `<other>` | any | Pass-through — preserved by backend, ignored by SPA. | n/a |

### Lifecycle (this feature does not change it)

- **Read**: SPA fetches once on first activation of the 模型价格 tab (FR-015). `GET /admin/models/pricing` returns the full catalog as JSON.
- **Refresh**: Admin clicks 立即刷新 → `POST /admin/models/pricing/refresh` → `pricingService.forceUpdate()` → on success, `pricingService.pricingData` is replaced atomically (JS reference assignment) and `pricingService.lastUpdated` is updated. On failure, both remain at their previous values; the previously bundled or downloaded catalog stays in effect.
- **Auto-refresh**: `pricingService` runs its own 24 h auto-update timer (`updateInterval`) plus a 10-min upstream-hash check (`hashCheckInterval`). Neither is changed by this feature.

### Visibility

- **Admin-facing**: `GET /admin/models/pricing` returns the full catalog (admin auth required).
- **Public**: Not exposed (out of scope; matches `main`).

---

## E2. Pricing Service Status (existing, surfaced read-only)

**Source**: Return value of `pricingService.getStatus()`.
**Frequency of change**: Updated whenever `lastUpdated` advances (every 24 h auto-update or on manual refresh).

### Wire shape (`GET /admin/models/pricing/status` → `data` field)

```json
{
  "initialized": true,
  "lastUpdated": "2026-04-28T10:23:45.000Z",
  "modelCount": 712,
  "nextUpdate": "2026-04-29T10:23:45.000Z"
}
```

### Field semantics

| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `initialized` | boolean | `true` once `pricingService.pricingData` is non-null. | `pricingService.pricingData !== null` |
| `lastUpdated` | string \| null | ISO-8601 timestamp of the last successful catalog load (download or fallback load). `null` if never loaded. | `pricingService.lastUpdated.toISOString()` |
| `modelCount` | number | `Object.keys(pricingService.pricingData).length`, or `0` when uninitialized. | derived |
| `nextUpdate` | string \| null | ISO-8601 timestamp of the next scheduled auto-update (`lastUpdated + 24h`). `null` when uninitialized. | `lastUpdated + updateInterval` |

### SPA usage

- The status card displays `modelCount` as "模型总数" and `lastUpdated` as "上次更新" (formatted via `toLocaleString('zh-CN')`).
- `nextUpdate` is informational; the main-branch component does not render it but the field is included for parity and possible future use.

---

## E3. Refresh Result (transient response)

**Source**: Return value of `pricingService.forceUpdate()`.
**Cardinality**: One per `POST /admin/models/pricing/refresh` call. Not persisted.

### Wire shape (`POST /admin/models/pricing/refresh` body)

```json
{
  "success": true,
  "message": "Pricing data updated successfully"
}
```

or

```json
{
  "success": false,
  "message": "Download failed: ETIMEDOUT. Using fallback pricing data instead."
}
```

### Field semantics

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` iff the upstream download completed and the new catalog is in memory; `false` if the download failed (in which case `pricingService.useFallbackPricing()` was invoked, but the SPA still shows a non-success toast). |
| `message` | string | Human-readable detail. Surfaced verbatim by the SPA toast (FR-012). |

### SPA usage

- On `success: true` → success toast + re-fetch catalog and status.
- On `success: false` → error toast displaying `message`. The previously loaded in-memory catalog is preserved by `pricingService.forceUpdate()` (it falls back to bundled pricing on download failure rather than zeroing the catalog), so the table remains usable.

### Behavioral guarantees (cross-checked against `pricingService.js`)

| Guarantee | Where enforced |
|-----------|----------------|
| Failed refresh does not empty the in-memory catalog | `pricingService.forceUpdate()` calls `useFallbackPricing()` on failure, which loads the bundled JSON. |
| Cost calculator continues to function during/after a failed refresh | `costCalculator.js` reads `pricingService.getModelPricing(model)` which dereferences `pricingService.pricingData` — never null after `initialize()`. |
| `lastUpdated` does not advance on failed refresh | `forceUpdate()`'s catch path falls through to fallback without setting `this.lastUpdated`. |
| Only admins can call any of the three endpoints | `authenticateAdmin` middleware on the new sub-router. |

---

## Validation summary

| Rule | Where enforced |
|------|----------------|
| All three endpoints require admin auth | `authenticateAdmin` middleware on `src/routes/admin/modelPricing.js`. |
| Catalog response preserves upstream field shape | Backend returns `pricingService.pricingData` directly without filtering. |
| Per-million-token rendering and missing-field display | SPA `formatPrice()` + `model.inputCost = (data.input_cost_per_token || 0) * 1e6` (R9, R10). |
| Status endpoint never throws | Reads in-memory state only; no I/O. |
| Refresh endpoint preserves prior catalog on failure | `pricingService.forceUpdate()` already implements fallback-on-failure semantics (R4). |
