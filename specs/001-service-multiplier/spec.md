# Feature Specification: Service Multiplier (服务倍率)

**Feature Branch**: `001-service-multiplier`
**Created**: 2026-04-28
**Status**: Draft
**Input**: User description: "main分支的系统设置下有服务倍率功能，请把它在本分支完整实现，两个分支有较大差异，需要了解功能后重新实现"

## Overview

The Service Multiplier feature lets administrators charge differentiated virtual-credit costs for usage of different upstream AI providers (Claude, Codex/OpenAI, Gemini, Droid, AWS Bedrock, Azure OpenAI, CCR) while continuing to maintain a single unified quota pool per API Key. By configuring a multiplier per service, the operator can subsidize cheaper services (e.g. Gemini at 0.5×) or surcharge premium ones (e.g. 1.5×). Real upstream cost (USD) is still tracked unchanged for auditing; only the *rated cost* deducted from API Key quotas is scaled.

This feature already exists on the `main` branch but is missing from the `dave` branch. Because the two branches have diverged significantly, the implementation must be reconstructed natively on `dave` rather than cherry-picked.

## Clarifications

### Session 2026-04-28

- Q: When the rate config read from the data store fails on the request hot path (transient outage, parse error, etc.), should the request fail open or fail closed? → A: Fail open — treat all multipliers as 1.0, log a warning, continue serving the request (real cost still recorded; rated cost = real cost for that request).
- Q: Where does the admin surface for setting per-API-Key service-rate overrides live? → A: Extend the existing admin Create/Edit API Key form with a new "Service Rate Overrides" section (no separate page or workflow); the corresponding admin REST endpoints accept the same new field.
- Q: How do OpenAI-family account types (`openai-responses`, `openai`) bind to service-multiplier buckets? → A: Map all OpenAI-family account types to the single canonical service ID `codex`; do not introduce a separate `openai` bucket.
- Q: What does the unauthenticated public service-rates endpoint expose? → A: Rates map + `baseService` + `updatedAt` only; the `updatedBy` admin username MUST NOT appear in the public payload (it remains visible only to authenticated admins).
- Q: For API-Key-facing usage / key-info endpoints, what cost values are exposed? → A: `ratedCost` only (the value driving the key's own quota); `realCost` remains visible only on admin-side endpoints for auditing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Global Service Rates in System Settings (Priority: P1)

As an **administrator**, I open the **System Settings → 服务倍率 (Service Rates)** tab in the admin web UI, see the current multiplier for each supported service, edit one or more values, and save the configuration. From that moment, every new API request routed to that service uses the new multiplier when calculating the rated cost deducted from the calling API Key's quota.

**Why this priority**: This is the core capability of the feature. Without it, no other behavior is possible. Delivers the entire MVP value (operators can rebalance pricing across services) on its own.

**Independent Test**: An admin can sign in, open System Settings, locate a "服务倍率" tab, change Gemini from 1.0 to 0.5, save, refresh the page, see the saved value persisted, then make a real Gemini API call through an API Key and verify that the rated cost recorded for the request is exactly half of the real upstream USD cost.

**Acceptance Scenarios**:

1. **Given** an admin is logged in and no service rates have ever been configured, **When** they open System Settings → 服务倍率, **Then** they see a card per supported service (Claude, Codex, Gemini, Droid, Bedrock, Azure, CCR) each defaulting to a 1.0 multiplier and a label indicating the base service.
2. **Given** the admin sets Gemini to 0.5 and clicks Save, **When** the page reloads, **Then** Gemini still shows 0.5 and a "last updated" timestamp + admin username are displayed.
3. **Given** Gemini's multiplier is 0.5, **When** an API Key makes a Gemini request whose real upstream cost is $0.10, **Then** the rated cost recorded against that API Key's quota is $0.05 while the real cost in admin statistics still shows $0.10.
4. **Given** Claude's multiplier is 1.0 (the base service), **When** an API Key makes a Claude request whose real upstream cost is $0.10, **Then** the rated cost equals $0.10.
5. **Given** the admin enters a value of 0 or a negative number for any service, **When** they click Save, **Then** the system rejects the change with a validation error and no rates are persisted.

---

### User Story 2 - Per-API-Key Rate Override (Priority: P2)

As an **administrator**, when I create or edit an API Key I can optionally override the global service multipliers for that specific key. Per-key overrides compose multiplicatively with the global rates so I can grant a key a discount or premium relative to the platform-wide setting.

**Why this priority**: Enables per-customer pricing flexibility. Strongly desired but not required for the platform-wide MVP — global rates alone deliver value.

**Independent Test**: Create an API Key whose Gemini override is 0.8, with the global Gemini rate set to 0.5. Issue a Gemini request whose real cost is $1.00 and verify that the rated cost recorded against this key is $0.40 ( = 1.00 × 0.5 × 0.8 ).

**Acceptance Scenarios**:

1. **Given** the global Gemini rate is 0.5 and an API Key has no per-key override, **When** the key calls Gemini, **Then** the rated cost equals real cost × 0.5.
2. **Given** the global Gemini rate is 0.5 and an API Key has a Gemini override of 0.8, **When** the key calls Gemini, **Then** the rated cost equals real cost × 0.5 × 0.8 = real cost × 0.4.
3. **Given** the global rates change later, **When** the key makes another request, **Then** the new global rate is used (cached for at most 60 seconds), still composed with the unchanged per-key override.

---

### User Story 3 - Public Read-Only Exposure of Current Rates (Priority: P3)

As a **client of the relay service** (or an unauthenticated visitor), I can read the current global service multipliers via a public endpoint so that downstream tooling, dashboards, or pricing pages can display up-to-date rates without holding an admin token.

**Why this priority**: Improves transparency for end-users and integrators but is not required for the multiplier itself to work.

**Independent Test**: Without authentication, fetch the public service-rates endpoint and verify the response includes every supported service, its current multiplier, the configured base service, and the last-updated timestamp.

**Acceptance Scenarios**:

1. **Given** the admin has saved a configuration with Gemini=0.5, **When** an unauthenticated client GETs the public service-rates endpoint, **Then** the response shows `gemini: 0.5` and the timestamp of the last save.
2. **Given** no admin has ever saved rates, **When** the public endpoint is called, **Then** it returns the default 1.0 multiplier for every supported service.

---

### Edge Cases

- **Unknown / new service type**: A request hits an account whose type is not in the configured rates map — system MUST default to 1.0 (no multiplier) and MUST NOT block the request.
- **Account/model with ambiguous service**: Detection MUST first try mapping by account type, then fall back to model-name pattern matching, finally defaulting to `claude` if nothing matches.
- **Multiplier removed for a service**: Loading config merges saved rates onto the canonical default map so newly-introduced services automatically get 1.0 until the admin saves an explicit value.
- **Cost calculation upstream returns 0 (e.g. cached or free model)**: Rated cost = 0 × multiplier = 0; system MUST NOT divide by zero or error.
- **Per-key override stored as malformed JSON**: System MUST treat it as no override and log a warning rather than failing the request.
- **Concurrent admin edits**: Last write wins; the response surface MUST include the `updatedAt` and `updatedBy` fields so admins can detect overwrites.
- **Boundary values**: The UI MUST constrain inputs to a sensible range (≥ 0.1 and ≤ 10) and MUST reject saves outside that range. Backend MUST also enforce `> 0` server-side (frontend constraints are not authoritative).
- **Quota enforcement**: API Key quota windows (daily / weekly / monthly / total) MUST consume the *rated* cost, not the real cost. Real cost remains visible only in admin-side statistics.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist a global multiplier value per supported service: `claude`, `codex`, `gemini`, `droid`, `bedrock`, `azure`, `ccr`.
- **FR-002**: System MUST default every multiplier to `1.0` when no admin configuration exists.
- **FR-003**: System MUST designate `claude` as the base service (always 1.0 by convention) and surface that designation to the admin UI.
- **FR-004**: System MUST expose admin endpoints that allow listing the current configuration and updating the configuration; updates MUST require admin authentication.
- **FR-005**: System MUST validate that every submitted multiplier is a strictly positive number (`> 0`) and reject the entire save otherwise.
- **FR-006**: System MUST record `updatedAt` (ISO timestamp) and `updatedBy` (admin username) on every successful save and return both in subsequent reads.
- **FR-007**: System MUST detect the appropriate service for each request first by mapping the upstream account type, then by inferring from model name, finally falling back to `claude`. The OpenAI-family account types (`openai-responses` and any plain `openai` variant) MUST both map to the single canonical service bucket `codex`; the multiplier config MUST NOT introduce a separate `openai` bucket.
- **FR-008**: System MUST compute the rated cost for every request as `realCost × globalRate(service) × keyOverrideRate(service, apiKey)`, defaulting any missing factor to `1.0`.
- **FR-009**: System MUST deduct only the rated cost from API Key quota counters; real upstream cost (USD) MUST continue to be recorded separately for admin-side statistics and audit.
- **FR-009a**: API-Key-facing endpoints (e.g. usage and key-info responses returned to the API Key holder) MUST expose only the rated cost. Real cost MUST remain visible only to authenticated admins via admin endpoints / admin UI for auditing.
- **FR-010**: System MUST allow an API Key to optionally carry per-service multiplier overrides; absence of an override MUST be equivalent to `1.0` for that service. The override field MUST be settable through the existing admin Create/Edit API Key form (a new "Service Rate Overrides" section) and through the corresponding admin REST endpoints — no new dedicated page or workflow is introduced.
- **FR-011**: System MUST expose a public, unauthenticated read endpoint returning the current global rates so clients can display them. The public payload MUST include only the `rates` map, the `baseService`, and the `updatedAt` timestamp; it MUST NOT include `updatedBy` (that field is reserved for the authenticated admin endpoint).
- **FR-012**: System MUST cache the loaded global configuration in process memory with a TTL not exceeding 60 seconds, and MUST invalidate the cache on save so admin changes propagate quickly.
- **FR-013**: Admin web UI MUST present a dedicated "服务倍率" entry within System Settings, listing every supported service with its name, icon, current multiplier (numeric input, step 0.1, min 0.1, max 10), and a "基准服务" badge for the base service.
- **FR-014**: Admin web UI MUST display the last-updated timestamp and admin username after the configuration is loaded or saved.
- **FR-015**: Admin web UI MUST disable the Save button while a save is in flight and surface success and error states clearly.
- **FR-016**: System MUST be backwards-compatible with existing usage records — i.e. records created before this feature shipped must not be retroactively altered, and deployments without saved rates must behave exactly like the prior 1.0× world.
- **FR-017**: System MUST log a warning (not throw) if a per-key override field is malformed, treating it as no override.
- **FR-019**: When the global rate configuration cannot be read on the request hot path (transient store error, parse error, etc.), the system MUST fail open: treat every multiplier as `1.0` for that request, log a warning, and continue serving so the request is not blocked. Real cost MUST still be recorded; rated cost for that request equals real cost.
- **FR-018**: System MUST support both light and dark mode in the new UI tab and be responsive across mobile, tablet, and desktop breakpoints (per project frontend rules).

### Key Entities

- **Service Rates Configuration**: A single, system-wide record holding the canonical map of `{ service → multiplier }`, the chosen `baseService` identifier, an `updatedAt` timestamp, and an `updatedBy` admin username. Persisted in the existing key-value store under one well-known key.
- **API Key Service-Rate Override**: An optional per-API-Key map of `{ service → multiplier }` stored as a field on the existing API Key record. Absence ⇒ no override for that service. Composes multiplicatively with the global rate.
- **Supported Service**: An enumerated value from the set `{ claude, codex, gemini, droid, bedrock, azure, ccr }`. Each has a localized display name, a Font Awesome icon class, and a Tailwind gradient class for the admin UI badge.
- **Usage Record (existing, extended semantics)**: Existing per-request cost record now stores both `realCost` and `ratedCost`; quota counters consume `ratedCost`; statistics views may show both.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can change a service multiplier and have it take effect for new requests within 60 seconds (matching the in-process cache TTL).
- **SC-002**: For 100% of requests routed through a service whose multiplier is `M`, the rated cost recorded against the API Key equals `realCost × M × keyOverride` within rounding tolerance of the existing cost-calculation precision.
- **SC-003**: API Key quota enforcement (daily / weekly / monthly / total windows) draws from the rated cost, verified by setting a $1 quota with Gemini at 0.5× and confirming the key can consume up to $2 of real upstream Gemini cost before being rate-limited.
- **SC-004**: Admin UI page-load for the 服务倍率 tab completes in under 2 seconds on a baseline production environment.
- **SC-005**: Existing pre-feature deployments behave identically (real cost == rated cost) when upgraded but not yet configured — verified by upgrading without saving rates and confirming no quota / billing regression.
- **SC-006**: All existing automated linters and the existing test suite continue to pass with the feature added.
- **SC-007**: At least one positive and one negative test case exist for: validation rejection of non-positive rates, service detection fallback to `claude`, malformed per-key override degradation, and quota enforcement using rated cost.

## Assumptions

- The current `dave` branch already supports all seven listed services (Claude, Codex/OpenAI Responses, Gemini, Droid, AWS Bedrock, Azure OpenAI, CCR). Service detection only needs to recognize, not introduce, these account types.
- The existing API Key record model is extensible with a new optional JSON field for per-service overrides; no schema migration is needed for stores that support hash-style records.
- The existing usage / cost recording pipeline already exposes a hook (or can be extended in one place) where rated cost can be computed and persisted alongside real cost.
- Admin authentication middleware on the `dave` branch is the same pattern as `main` (i.e., a single `authenticateAdmin` middleware can guard the new admin endpoints).
- The frontend admin SPA already has a System Settings view with a tab/section pattern that this feature can extend, plus existing utilities for HTTP calls, theme, and i18n-style display name maps.
- "Base service" is a UI-only concept (always 1.0 by convention for `claude`); changing it is not in scope for this iteration.

## Out of Scope

- Time-based rate scheduling (e.g. peak/off-peak rates).
- Per-model multipliers (overrides are per *service*, not per individual model).
- Currency conversion or non-USD billing.
- Historical re-pricing of past usage records.
- Programmatic API for end-users to *modify* rates (only an admin UI + read-only public endpoint).
- Bulk-import / export of rate configurations.
