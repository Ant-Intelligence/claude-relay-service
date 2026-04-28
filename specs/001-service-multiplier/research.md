# Phase 0 Research — Service Multiplier (服务倍率)

**Feature**: 001-service-multiplier
**Date**: 2026-04-28
**Status**: Complete — no remaining `NEEDS CLARIFICATION` items.

This file resolves engineering questions raised by adapting the `main`-branch feature design to the diverged `dave` branch. Product-level ambiguities were already closed in the spec's Clarifications session 2026-04-28.

---

## R1: Hot-path integration point in `dave`

**Decision**: Apply the multiplier inside `src/services/apiKeyService.js`, in the existing methods `recordUsage` (line ~1263) and `recordUsageWithDetails` (line ~1477). After computing `realCost` (via `CostCalculator` or `pricingService`), compute `ratedCost = realCost × globalRate × keyOverrideRate`, then pass `ratedCost` to `redis.incrementDailyCost`, `redis.incrementWeeklyCost`, `redis.incrementTokenUsage(... cost)`, and pass both `realCost` and `ratedCost` to `redis.addUsageRecord`.

**Rationale**: These two methods are the *only* code paths in dave that record cost (verified by grep). They are called from every route file (`api.js`, `openaiClaudeRoutes.js`, `openaiRoutes.js`, `openaiGeminiRoutes.js`, `azureOpenaiRoutes.js`, `droidRoutes.js`, `geminiHandlers.js`, etc.) so a single integration point catches every relayed request without per-route changes.

**Alternatives considered**:
- *Apply at the redis layer (`redis.incrementDailyCost`)*: rejected — redis layer should remain a pure data sink; adding business logic here couples cost-shaping to storage and breaks the modularity principle.
- *Apply per-route in each relay service*: rejected — would require touching ~10 files and creates duplication risk.

---

## R2: Service-ID mapping from dave's account types

**Decision**: Detect the multiplier-bucket service ID by mapping the `accountType` parameter passed to `recordUsageWithDetails`, with a model-name fallback for `recordUsage` (which doesn't take `accountType`).

| `accountType` value (dave) | Service bucket |
|----------------------------|----------------|
| `claude` / `claude-official` / `claude-console` | `claude` |
| `ccr` | `ccr` |
| `bedrock` | `bedrock` |
| `gemini` / `gemini-api` | `gemini` |
| `openai` / `openai-responses` | `codex` |
| `azure-openai` | `azure` |
| `droid` | `droid` |
| anything else | model-name inference, default `claude` |

Model-name inference fallback:
- `claude*`, `opus*`, `sonnet*`, `haiku*` → `claude`
- `gpt*`, `o1*`, `o3*`, `codex*`, `davinci*` → `codex`
- `gemini*`, `palm*`, `bard*` → `gemini`
- `bedrock*`, `amazon*`, `titan*` → `bedrock`
- `azure*` → `azure`
- `droid*`, `factory*` → `droid`
- otherwise → `claude`

**Rationale**: Account type is authoritative when present; spec Q3 explicitly merges all OpenAI-family types into the single `codex` bucket. Model-name fallback handles legacy `recordUsage` call sites that lack `accountType`.

**Alternatives considered**:
- *Separate `openai` bucket alongside `codex`*: rejected per Q3 (admin would need to keep two values in sync).
- *Require all callers to migrate to `recordUsageWithDetails`*: out of scope — too large a change for this feature; model-name fallback covers the gap.

---

## R3: Per-key override storage shape

**Decision**: Store a JSON-encoded object on the existing `api_key:{id}` Redis hash under field name `serviceRates`. Empty or absent ⇒ no override. Malformed JSON ⇒ log a warning, treat as no override.

```text
HSET api_key:abc-123 serviceRates '{"gemini":0.8,"codex":1.2}'
```

**Rationale**: Matches how other extensible per-key fields are stored on this branch (e.g. `restrictions`, `clientRestrictions`, `modelBlacklist` are JSON-stringified hash fields). No schema change. `getApiKey` already returns the field as a string; the new service module parses it once per request from cache-miss.

**Alternatives considered**:
- *Separate `api_key_service_rates:{id}` Redis key*: rejected — adds a second round-trip per request and a second cleanup path on key deletion.
- *Store as Redis hash with `service-rate:{service}` fields*: rejected — flatter but harder to atomically replace and noisier on reads.

---

## R4: Caching strategy for the global config

**Decision**: A single process-local cache inside `serviceRatesService.js`:

```js
let cache = null  // { config, expiresAt }
const TTL_MS = 60_000
```

Reads check `expiresAt` and refresh from Redis on miss/expiry. `setRates` invalidates the cache (`cache = null`) before responding.

**Rationale**: Spec FR-012 caps TTL at 60 s. Process-local caching is sufficient because the multiplier is a billing knob — temporary skew across cluster nodes for ≤ 60 s is acceptable, and the simplicity is worth the small inconsistency window. No need for Redis pub/sub invalidation.

**Alternatives considered**:
- *Redis pub/sub invalidation for instant propagation*: rejected — adds operational complexity and a long-lived subscriber for a 60 s benefit.
- *No cache at all, hit Redis every request*: rejected — adds a Redis round-trip to the hot path of every relayed request (could be hundreds per second).

---

## R5: Hot-path failure mode

**Decision**: On any error reading the global config (Redis error, parse error, etc.), log a `warn`-level Winston entry and treat every multiplier as `1.0` for that request. `ratedCost = realCost`. The request continues normally.

**Rationale**: Closed by spec Q1 (Clarifications session 2026-04-28). Service multipliers are a billing-shaping feature, not a security control; failing closed would convert a config-store hiccup into a user-visible 5xx on every relayed request.

**Alternatives considered**: See spec Q1 options B (fail closed) and C (last-known cache). Both rejected by the user.

---

## R6: Public read endpoint placement

**Decision**: Mount as `GET /apiStats/service-rates` inside the existing `src/routes/apiStats.js` router (already mounted at `/apiStats` and is the canonical home for unauthenticated stats endpoints). Payload omits `updatedBy` (per spec Q4).

**Rationale**: `apiStats.js` is the only existing router on dave that exposes unauthenticated read endpoints. Co-locating the new endpoint keeps the auth boundary obvious and reuses existing CORS/rate-limit configuration on that router.

**Alternatives considered**:
- *Mount under `/admin/service-rates/public`*: rejected — putting a public endpoint under `/admin/` is misleading and creates auth-middleware confusion.
- *Create a new `/public/service-rates` router*: rejected — gratuitous for a single endpoint.

---

## R7: Backward-compatible reads of usage records

**Decision**: On admin-side stats endpoints, when reading historical usage records that lack the `ratedCost` field, treat `ratedCost = realCost` (i.e., legacy 1.0× world). Do not back-fill or migrate existing records.

**Rationale**: Spec FR-016 explicitly forbids retroactive alteration. The fallback is one line of code (`record.ratedCost ?? record.cost`) and preserves the principle "Backward Compatibility" from the constitution.

**Alternatives considered**:
- *Run a one-shot migration to back-fill `ratedCost`*: rejected — violates FR-016 (no retroactive alteration) and would be an unnecessary write storm on production Redis.

---

## R8: SPA tab integration pattern

**Decision**: Extend `web/admin-spa/src/views/SettingsView.vue` to add a third tab `serviceRates` to the existing `activeSection` switch (`branding` and `webhook` tabs already use this pattern at lines 18, 22, 30, 34, 51, 373, 1234). Add a watcher branch in `sectionWatcher` to lazy-load the rates on first activation.

For the per-key override controls, extend the existing API Key Create/Edit form component (under `web/admin-spa/src/components/apikeys/` or wherever `ApiKeysView.vue` mounts the form) with a collapsible "Service Rate Overrides" section.

**Rationale**: Matches the established intra-view tab pattern; minimal new structural code; preserves dark mode and responsive behaviour because the surrounding component already handles them.

**Alternatives considered**:
- *Create a dedicated `ServiceRatesView.vue` route*: rejected — spec Q2 keeps the override surface inside the existing API Key form; for the global rates the user explicitly placed it under System Settings as a tab.

---

## Summary

All Phase 0 research items are resolved. No `NEEDS CLARIFICATION` markers remain. Proceed to Phase 1 (Design & Contracts).
