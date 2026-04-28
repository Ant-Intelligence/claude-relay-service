# Feature Specification: Model Pricing (模型价格)

**Feature Branch**: `001-model-pricing`
**Created**: 2026-04-28
**Status**: Draft
**Input**: User description: "main分支系统设置中有模型价格功能，请在当前分支的基础上实现，两个分支有差异，不能直接合并，需要重新实现。"

## Overview

The Model Pricing feature exposes the price catalog that the relay service uses to compute the upstream USD cost of each request. Today the catalog is loaded by the existing `pricingService` from a bundled JSON file plus a periodic remote sync, but administrators have no in-product way to see what is loaded, how fresh it is, or to trigger a manual re-sync. This feature adds a read-only **System Settings → 模型价格** tab that surfaces every known model, its per-million-token prices (input / output / cache create / cache read) and context window, alongside a status card showing the total model count and last-updated timestamp, with a "立即刷新" button that forces a remote re-download.

This feature already exists on the `main` branch but is missing from the `dave` branch. Because the two branches have diverged significantly (different admin sub-router layout, different SPA HTTP-client convention, different `pricingService` internals — although the public methods `getStatus()` / `forceUpdate()` / `pricingData` are present on both), the implementation must be reconstructed natively on `dave` rather than cherry-picked.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse the model price catalog (Priority: P1)

As an **administrator**, I open the **System Settings → 模型价格** tab in the admin web UI and see a sortable, searchable table of every model the relay service can price, with their input / output / cache-create / cache-read price per million tokens and their context-window size. Above the table, a status card shows the total model count and when the catalog was last updated.

**Why this priority**: This is the core capability of the feature. Operators frequently need to verify what price the system will use for a given model — e.g. when investigating a cost discrepancy, onboarding a new model, or quoting a customer. Without this view, the only way to inspect the catalog today is to read the JSON file on the server. Delivers the entire MVP value (price visibility and audit) on its own.

**Independent Test**: An admin signs in, opens System Settings, locates a "模型价格" tab between the existing tabs, and sees a status card that reads "模型总数: N" and "上次更新: <timestamp>" plus a table containing well-known models such as `claude-sonnet-4-5`, `gemini-2.5-pro`, `gpt-5`, etc. Typing into the search field narrows the table to matches; clicking a sortable column header reorders the rows.

**Acceptance Scenarios**:

1. **Given** an admin is logged in and the pricing service has loaded the bundled catalog, **When** they open System Settings → 模型价格, **Then** they see a status card showing the total model count and a non-empty timestamp, plus a table with at least 100 model rows.
2. **Given** the tab is open, **When** the admin types `claude` into the search box, **Then** only rows whose model name contains "claude" remain visible and the "showing X / Y" counter updates accordingly.
3. **Given** the tab is open, **When** the admin clicks the "输入 $/MTok" column header, **Then** rows reorder by ascending input price; clicking again reverses to descending.
4. **Given** a model has no cache pricing fields in the catalog, **When** the row is rendered, **Then** the cache-create and cache-read columns show `-` instead of `$0` to avoid implying a real zero price.
5. **Given** the pricing service has not yet finished loading on first start, **When** the admin opens the tab, **Then** they see a loading indicator that is replaced by the table once the catalog is available.

---

### User Story 2 - Filter by upstream platform (Priority: P2)

As an **administrator**, I want to narrow the catalog down to a single upstream platform (Claude, Gemini, OpenAI, or "other") with a single click so that I do not have to scroll past hundreds of unrelated models when I am only interested in one provider's pricing.

**Why this priority**: Large catalogs (~500–800 entries) make the unfiltered table unwieldy. Strongly desired but not required for the read-only MVP — search alone covers the basic auditing flow.

**Independent Test**: With the table loaded, click the "Claude" platform tab; verify the table reduces to rows whose model names match Claude (e.g. `claude-*`). Click "OpenAI" and verify rows match `gpt-*`, `o1-*`, `o3-*`, `o4-*`, or `codex*`. Click "全部" to restore the full list.

**Acceptance Scenarios**:

1. **Given** the table shows all models, **When** the admin clicks the "Gemini" tab, **Then** only Gemini-family rows remain and the "showing X / Y" counter reflects the filtered count.
2. **Given** a Gemini filter is active and a search query "flash" is entered, **When** the table re-renders, **Then** only models that are both Gemini-family AND contain "flash" in their name appear.
3. **Given** the admin clicks the "其他" tab, **When** the table re-renders, **Then** it excludes Claude, Gemini, and OpenAI-family models and shows e.g. DeepSeek, Llama, Mistral models if present.

---

### User Story 3 - Manually refresh from upstream (Priority: P3)

As an **administrator**, when I know the upstream pricing source has been updated (e.g. a new model just launched), I want to click a "立即刷新" button to immediately re-download the catalog without waiting for the next scheduled sync or restarting the service. After refresh, the status card and table reflect the new data.

**Why this priority**: Improves operator agility but is not critical — the underlying service already auto-syncs on a schedule and falls back to bundled pricing on download failure, so manual refresh is a convenience.

**Independent Test**: Click "立即刷新" while the server is connected to the upstream pricing source. Confirm a success toast appears and the "上次更新" timestamp advances to "just now". Then disconnect the server from the pricing source and click again; confirm an error toast surfaces a meaningful message and the previous catalog remains intact (the system does not break or empty the table on failure).

**Acceptance Scenarios**:

1. **Given** the network is healthy and the upstream pricing source is reachable, **When** the admin clicks "立即刷新", **Then** within a few seconds a success toast appears, the "上次更新" timestamp updates, and the model count may change if the upstream catalog changed.
2. **Given** the upstream pricing source is unreachable or returns an error, **When** the admin clicks "立即刷新", **Then** an error toast surfaces a human-readable failure reason, the previously loaded catalog remains visible, and the "上次更新" timestamp does not advance.
3. **Given** a refresh is in flight, **When** the admin clicks the button repeatedly, **Then** subsequent clicks are ignored (button shows "刷新中..." and is disabled) until the in-flight request completes.

---

### Edge Cases

- **Pricing service not initialized at request time**: If the admin opens the tab before `pricingService.initialize()` has finished, the endpoints MUST trigger or wait for initialization rather than returning an empty payload.
- **Empty / malformed catalog file**: If the bundled JSON cannot be parsed, the system MUST fall back to the existing in-memory catalog (or an empty object) and surface a clear error in the status response rather than crashing the admin route.
- **Refresh during failure**: A failed manual refresh MUST NOT clobber the existing in-memory catalog. Real cost calculation MUST continue to work using the previously loaded prices.
- **Very large catalog (>1000 models)**: The table MUST remain usable on a typical 1280×800 display via search + filter; full virtualization is not required.
- **Models with mixed price representations**: Some entries store `cache_creation_input_token_cost`, others omit it; the display layer MUST treat missing fields as "no price" (rendered as `-`), not as zero.
- **Concurrency with other admin operations**: A manual refresh MUST NOT block other admin endpoints; the in-flight HTTP request is awaited only by the refresh handler.
- **Public endpoint**: This feature does NOT expose a public unauthenticated endpoint for pricing. The catalog itself is non-sensitive but exposing it without auth is out of scope (see Out of Scope).
- **Mobile / narrow viewport**: Cache columns and context-window column MUST hide on smaller breakpoints (model name, input price, output price stay visible).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose an admin-only endpoint that returns the entire current in-memory pricing catalog as a JSON object keyed by model name. Each entry MUST preserve the upstream schema (e.g. `input_cost_per_token`, `output_cost_per_token`, `cache_creation_input_token_cost`, `cache_read_input_token_cost`, `max_tokens` / `max_output_tokens`).
- **FR-002**: System MUST expose an admin-only endpoint that returns service status: at minimum a boolean indicating whether the catalog is initialized, the last-updated timestamp (ISO-8601 or `null`), the total model count, and the next scheduled auto-update timestamp (or `null`).
- **FR-003**: System MUST expose an admin-only endpoint that triggers an immediate remote re-download of the catalog. The endpoint MUST return a success / failure indicator and a human-readable message; on failure, the previously loaded in-memory catalog MUST remain intact.
- **FR-004**: All three endpoints MUST require admin authentication using the existing admin auth middleware. Unauthenticated callers MUST receive `401`.
- **FR-005**: Admin web UI MUST present a dedicated "模型价格" tab within System Settings, alongside the existing tabs (e.g. 品牌定制 / Webhook 通知 / 服务倍率).
- **FR-006**: Admin web UI MUST show a status card above the table with: the total model count, the last-updated timestamp formatted in the user's locale (or "未知" when null), and a "立即刷新" button.
- **FR-007**: Admin web UI MUST render a table with one row per model, with columns: 模型名称 (with a smaller provider hint such as "Anthropic" / "Google" / "OpenAI" derived from the name), 输入 $/MTok, 输出 $/MTok, 缓存创建 $/MTok, 缓存读取 $/MTok, 上下文窗口.
- **FR-008**: Admin web UI MUST provide a free-text search input that filters rows whose model name (case-insensitive substring match) matches the query.
- **FR-009**: Admin web UI MUST provide platform filter tabs labelled 全部 / Claude / Gemini / OpenAI / 其他, each filtering the table by name patterns appropriate for that family.
- **FR-010**: Admin web UI MUST allow sorting by 模型名称 / 输入 $/MTok / 输出 $/MTok via clickable column headers, with a visible ascending/descending indicator.
- **FR-011**: Admin web UI MUST disable the "立即刷新" button while a refresh is in flight and visibly indicate the in-flight state (e.g. "刷新中..." label + spinner).
- **FR-012**: Admin web UI MUST surface success and failure of refresh via the existing toast pattern, without leaving the page or losing the current table state on failure.
- **FR-013**: Per-million-token prices MUST be rendered using the upstream per-token values multiplied by 1,000,000, formatted with reasonable precision (e.g. 4 decimals when < $0.01, 3 decimals when < $1, otherwise 2 decimals). Missing or zero values MUST render as `-`, not `$0.00`.
- **FR-014**: Context window size MUST be rendered in a human-friendly form (e.g. `200K`, `1M`, `2M`) using `max_tokens` if present, otherwise `max_output_tokens`. Missing values MUST render as `-`.
- **FR-015**: Admin web UI MUST lazy-load the pricing tab (i.e. the catalog and status are only fetched on first activation of this tab, not on initial Settings page load), consistent with the existing tab-loading pattern in this view.
- **FR-016**: Admin web UI MUST support both light and dark modes and remain usable across mobile, tablet, and desktop breakpoints (per project frontend rules); cache and context-window columns MAY hide at narrower breakpoints.
- **FR-017**: System MUST NOT introduce any new persistent storage. The pricing catalog is already loaded by the existing `pricingService`; this feature only adds read endpoints and a manual-refresh trigger over what is already there.
- **FR-018**: System MUST NOT alter the existing cost-calculation hot path. The new endpoints are read-only with respect to in-flight billing; the manual-refresh endpoint MAY swap the in-memory catalog atomically (existing service behavior) but MUST NOT block billing while doing so.
- **FR-019**: Admin web UI MUST NOT expose any UI to **edit** an individual model's price. Pricing is sourced exclusively from the upstream JSON; per-model overrides are out of scope.

### Key Entities

- **Pricing Catalog (existing, read-only here)**: The in-memory `pricingService.pricingData` object keyed by model name. Each entry holds per-token costs (input / output / cache create / cache read) and context-window metadata. Loaded on service start and on scheduled / manual refresh; persisted on disk as a single JSON file managed by the existing `pricingService`. This feature only reads it.
- **Pricing Service Status (existing)**: A small object exposing `{ initialized, lastUpdated, modelCount, nextUpdate }` derived from the in-memory state. Returned by the existing `pricingService.getStatus()` method; surfaced via the new admin endpoint.
- **Refresh Result (transient)**: The return value of `pricingService.forceUpdate()`: `{ success: boolean, message: string }`. Returned by the new manual-refresh endpoint; not persisted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can locate and open the 模型价格 tab and see a fully populated table within 2 seconds on a baseline production environment.
- **SC-002**: For 100% of models present in `pricingService.pricingData`, the corresponding row in the table shows the same per-million-token prices that the cost-calculation pipeline uses for billing (within rounding tolerance of the existing display precision).
- **SC-003**: Searching for any common model name fragment (e.g. `claude`, `gpt`, `gemini`) returns results in under 200 ms of perceived latency, since the filtering is client-side over the already-loaded catalog.
- **SC-004**: A manual "立即刷新" click that succeeds reflects the new "上次更新" timestamp within 5 seconds of the upstream response, on a baseline production network.
- **SC-005**: A manual refresh that fails (network error, source unreachable) keeps the previously loaded catalog visible and shows an error toast within 10 seconds; the existing cost-calculation pipeline continues to use the previous catalog without disruption.
- **SC-006**: All existing automated linters and the existing test suite continue to pass with the feature added.
- **SC-007**: At least one positive and one negative test case exist for: admin auth gating on each of the three new endpoints, refresh-failure preserving the prior catalog, and the per-million conversion of per-token prices in the UI.

## Assumptions

- The existing `pricingService` on `dave` already implements the methods this feature depends on: `pricingData` (object), `lastUpdated` (Date), `loadPricingData()`, `getStatus()`, and `forceUpdate()`. (Verified before drafting this spec.)
- The existing admin auth middleware on `dave` (`authenticateAdmin`) is the same pattern used by the just-shipped `001-service-multiplier` feature and can guard the three new endpoints in the same way.
- The frontend SPA already has a System Settings view (`SettingsView.vue`) with a tab-section pattern that this feature can extend; `web/admin-spa/src/config/api.js` is the project's HTTP-client convention (per the `001-service-multiplier` baseline).
- The pricing catalog is non-sensitive enough that admin-only access (matching `main`) is sufficient; no public endpoint is needed for this iteration.
- The upstream pricing source URL and download mechanics are already configured (`config/pricingSource.js` plus `pricingService.downloadPricingData()`); this feature does not change them.
- Browser-side filter / sort over a few hundred to ~one thousand model rows is performant without virtualization; if catalogs grow beyond ~5,000 rows, virtualization can be added in a follow-up.

## Out of Scope

- Editing individual model prices through the admin UI (read-only by design).
- Per-account-type or per-API-Key price overrides (this is the role of the separate Service Multiplier feature; not duplicated here).
- A public, unauthenticated `/apiStats/...` endpoint for the pricing catalog.
- Configuring the upstream pricing source URL through the admin UI (file-config only for this iteration).
- Historical pricing diffs / changelogs (showing what changed between the previous catalog and the latest one).
- Bulk export / import of a custom pricing file through the admin UI.
- Price-change webhooks or notifications.
