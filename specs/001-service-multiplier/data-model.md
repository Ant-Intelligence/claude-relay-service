# Data Model — Service Multiplier (服务倍率)

**Feature**: 001-service-multiplier
**Storage**: Redis (existing ioredis client)

This file enumerates every persisted data shape, its location, validation rules, and lifecycle. Two new persistent shapes plus one extension to existing usage records.

---

## E1. ServiceRatesConfig (NEW)

**Redis key**: `system:service_rates`
**Type**: Hash (preferred for partial reads) **OR** JSON string under one hash field — implementer picks; the contract is on the shape below.
**Cardinality**: Exactly one record per deployment.
**Cache**: In-memory inside `serviceRatesService` with 60 s TTL (FR-012).

### Fields

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `rates` | object — `{ service → multiplier }` | Per-service multiplier map. Keys are service IDs (see E4). | Every value is a finite number `> 0`. Server-side enforces `> 0`; UI further restricts to `[0.1, 10]` (FR-005, FR-013). |
| `baseService` | string | The canonical "1.0" service for display purposes. Always `claude` in this iteration. | Must be one of E4 service IDs; must exist as a key in `rates`. |
| `updatedAt` | string (ISO-8601) | Timestamp of the last successful save. Set server-side. | RFC 3339 / ISO-8601. |
| `updatedBy` | string | Username of the admin who last saved. | Sourced from `req.admin?.username`. **Never returned by the public endpoint** (FR-011). |

### Default value (when key is absent)

```json
{
  "rates": {
    "claude": 1.0,
    "codex": 1.0,
    "gemini": 1.0,
    "droid": 1.0,
    "bedrock": 1.0,
    "azure": 1.0,
    "ccr": 1.0
  },
  "baseService": "claude",
  "updatedAt": null,
  "updatedBy": null
}
```

### Lifecycle

- **Read (admin)**: `GET /admin/service-rates` returns the merged result (defaults ∪ stored). New service IDs added in future code releases automatically appear with default 1.0 (FR-002, R-defaults).
- **Read (public)**: `GET /apiStats/service-rates` returns the same payload **minus** `updatedBy`.
- **Read (hot path)**: `serviceRatesService.getRate(service)` — uses in-memory cache; returns 1.0 on any read failure (FR-019).
- **Write**: `PUT /admin/service-rates` replaces `rates` (and optionally `baseService`); sets `updatedAt = new Date().toISOString()`, `updatedBy = req.admin.username`; invalidates the in-memory cache.

---

## E2. ApiKeyServiceRateOverride (NEW — field on existing entity)

**Storage**: A field named `serviceRates` on the existing Redis hash `api_key:{id}`.
**Encoding**: JSON-stringified `{ service → multiplier }` object.
**Cardinality**: 0 or 1 per API Key.

### Fields (within the JSON object)

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `<serviceId>` | number | Per-service override factor for this API Key. | Finite, `> 0`. Same UI bound `[0.1, 10]`. Missing key = no override = 1.0. |

### Default value

If the field is absent from the hash, the empty string, `"null"`, malformed JSON, or `"{}"` — all are treated as "no overrides" (FR-010, FR-017). A malformed JSON value emits a `warn`-level log and is treated as `{}`.

### Read / Write paths

- **Read**: `apiKeyService` reads the API Key hash via existing `redis.getApiKey(keyId)` once per request; the new code path parses `data.serviceRates` if present.
- **Write**: Set inside the existing `POST /admin/api-keys` and `PUT /admin/api-keys/:keyId` route handlers. Body accepts an optional `serviceRates` object; the handler validates each value (`> 0`, finite) and stores it as `JSON.stringify(...)` on the hash. Empty/missing object stores `""` or omits the field entirely.

### Composition rule

For each request:

```text
ratedCost = realCost
            × (globalRates[service] ?? 1.0)
            × (keyOverrides[service] ?? 1.0)
```

(FR-008.) Both factors default to 1.0 when missing. `service` is determined by the detection rules in `research.md` R2.

---

## E3. UsageRecord (EXTENSION of existing entity)

**Storage**: Existing Redis structures (`addUsageRecord` list; `usage:cost:daily:{keyId}:{date}`; `usage:cost:weekly:total:{keyId}`; `usage:cost:total:{keyId}`; `usage:cost:monthly:{keyId}:{yyyy-mm}`; `model_daily:{model}:{date}` cost field; etc.).

### Behavior changes (no schema change)

| Counter / Record | Was | Becomes |
|------------------|-----|---------|
| `usage:cost:daily:{keyId}:{date}` | `realCost` | **`ratedCost`** (FR-009) |
| `usage:cost:monthly:{keyId}:{yyyy-mm}` | `realCost` | **`ratedCost`** |
| `usage:cost:total:{keyId}` | `realCost` | **`ratedCost`** |
| `usage:cost:weekly:total:{keyId}` (when `weeklyCostLimit > 0`) | `realCost` | **`ratedCost`** |
| `model_daily:*` and `model_monthly:*` `cost` field (admin stats) | `realCost` | **`realCost`** (unchanged — admin audit trail) |
| `redis.addUsageRecord(... { cost, costBreakdown })` | `cost = realCost` | `cost = realCost` PLUS new field `ratedCost` (so historical reads remain compatible). Pre-feature records lack `ratedCost`; readers fall back to `cost` (FR-016, R7). |

### Reader fallback (admin-side stats)

```js
const ratedCost = record.ratedCost ?? record.cost ?? 0
const realCost  = record.cost ?? 0
```

### Visibility

- **Key-facing endpoints** (`/api/v1/usage`, `/api/v1/key-info`, `/apiStats/...` user endpoints): show **`ratedCost` only** (FR-009a). Rename or remap as `cost` in the response payload to preserve existing field-name shape; never include the real upstream USD figure.
- **Admin-facing endpoints** (`/admin/dashboard`, `/admin/api-keys/:keyId/cost-debug`, etc.): show **both** as labeled fields `realCost` and `ratedCost`.

---

## E4. Supported Service (enumeration)

| Service ID | Display name | Icon (Font Awesome) | Tailwind gradient | Notes |
|------------|--------------|---------------------|-------------------|-------|
| `claude` | Claude | `fa-robot` | `from-orange-400 to-orange-600` | Base service (always 1.0 by convention) |
| `codex` | Codex (OpenAI) | `fa-brain` | `from-emerald-400 to-emerald-600` | Covers `openai` and `openai-responses` account types |
| `gemini` | Gemini | `fa-gem` | `from-blue-400 to-blue-600` | |
| `droid` | Droid | `fa-android` | `from-purple-400 to-purple-600` | Factory.ai |
| `bedrock` | AWS Bedrock | `fa-aws` | `from-amber-400 to-amber-600` | |
| `azure` | Azure OpenAI | `fa-microsoft` | `from-cyan-400 to-cyan-600` | |
| `ccr` | CCR | `fa-server` | `from-slate-400 to-slate-600` | |

Implementer may adjust icon/gradient values to match existing SPA palette; the service IDs themselves are the contract.

---

## Validation summary

| Rule | Where enforced |
|------|----------------|
| `value > 0` and finite | Server-side in `serviceRatesService.saveRates` and in `POST/PUT /admin/api-keys` for the override field. |
| `0.1 ≤ value ≤ 10` | UI input `min`/`max`/`step` attributes (FR-013). NOT enforced server-side beyond the `> 0` rule (UI is not authoritative; defense-in-depth via `> 0`). |
| Service ID ∈ E4 | Server-side. Unknown IDs in a request body cause a 400; unknown IDs *already present in storage* are passed through (forward compatibility for older deployments). |
| `baseService ∈ rates` | Server-side. |
| Override JSON parses | If parse fails, log warn and treat as no override (FR-017). |
| Hot-path read failure | Fail open with all-1.0 (FR-019). |
