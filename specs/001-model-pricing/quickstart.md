# Quickstart — Model Pricing (模型价格) Manual Verification

**Feature**: 001-model-pricing
**Audience**: Engineer verifying the implementation against the spec.
**Prerequisite**: A running `dave` dev environment (`npm run dev`) with the pricing service initialized (i.e. the bundled or downloaded `model_pricing.json` is loaded). Admin login works at `http://localhost:3000/admin-next/`.

Each section maps to one or more Acceptance Scenarios in `spec.md`. Walk all 8 against a running build before claiming the feature complete.

---

## 1. Open the new tab and verify the status card + table render (US1, AC-1, AC-5; FR-005, FR-006, FR-007, FR-015)

1. Sign in as an admin and navigate to **System Settings** (`/admin-next/settings`).
2. Locate the **模型价格** tab in the row of tabs alongside 品牌定制 / Webhook 通知 / 服务倍率.
3. Click the tab.
4. Observe the status card above the table:
    - "模型总数: N" where N is at least 100 on a typical install.
    - "上次更新: <human-readable timestamp>" (or a brief loading state if the service was just initialized).
5. Observe the table populated with one row per model.

**Expected**: Status card and table render within ~2 s. No console errors.

**Edge case (AC-5)**: If you reload right after `npm run dev` start, you may see a brief loading spinner before the data arrives — verify it is replaced by the table once loaded.

---

## 2. Verify per-million-token conversion of prices (FR-013)

1. With the table loaded, locate the row for `claude-sonnet-4-5` (or any model whose per-token pricing you can cross-reference).
2. Read the **输入 $/MTok** and **输出 $/MTok** columns.
3. Open `data/model_pricing.json` and find the same entry. Multiply `input_cost_per_token` by 1,000,000.

**Expected**: The displayed value equals the per-token cost × 1,000,000, formatted with the precision rules from FR-013 (≤4 dp under $0.01, ≤3 dp under $1, otherwise 2 dp). For a model with `input_cost_per_token: 0.000003`, the table shows `$3.00`.

**Cross-check**: Find a model entry that does NOT have `cache_creation_input_token_cost` (e.g. a non-Claude model) and verify its 缓存创建 / 缓存读取 columns show `-`, NOT `$0.00`.

---

## 3. Verify search filters the table (US1, AC-2; FR-008)

1. With the table loaded, type `claude` into the search box.
2. Observe the table filter to rows whose model name contains "claude" (case-insensitive).
3. Observe the "显示 X / Y" counter update.
4. Clear the search.

**Expected**: Search is purely client-side (no network request fires when you type). Filtering completes within ~200 ms perceived latency. Counter reflects filtered vs. total.

---

## 4. Verify sortable columns (US1, AC-3; FR-010)

1. Click the **输入 $/MTok** column header. Verify rows reorder ascending (cheapest input first) and a sort indicator (e.g. `fa-sort-up`) appears next to the header.
2. Click the same header again. Verify rows reorder descending and the indicator flips (`fa-sort-down`).
3. Click **模型名称**. Verify alphabetical sort.
4. Click **输出 $/MTok**. Verify ascending output price.

**Expected**: Sort is purely client-side. Indicator visible on the active sort column only.

---

## 5. Verify platform tabs filter the table (US2, AC-1, AC-2, AC-3; FR-009)

1. With **全部** active, note the total row count.
2. Click **Claude**. Verify only models whose name contains "claude" remain.
3. Click **Gemini**. Verify only models whose name contains "gemini" remain.
4. Click **OpenAI**. Verify only models whose name contains `gpt`, `o1`, `o3`, `o4`, or `codex` remain.
5. Click **其他**. Verify it excludes the four families above (look for e.g. `deepseek-*`, `llama-*` if present).
6. Type `flash` into the search box while **Gemini** is still active. Verify the table is filtered to entries that are both Gemini-family AND contain "flash".
7. Click **全部** to restore the unfiltered view.

**Expected**: Filter + search compose. Counter reflects compound filter.

---

## 6. Verify successful manual refresh (US3, AC-1; FR-011, FR-012, SC-004)

1. With the tab open and the network reachable, click **立即刷新**.
2. Observe the button label change to "刷新中..." and become disabled. Verify clicking again has no effect.
3. Within ~5 s, expect:
    - A green success toast (e.g. "价格数据已刷新").
    - The "上次更新" timestamp advance to "just now".
    - The model count possibly change (if upstream catalog has more entries than before).

**Expected**: Catalog round-trip in < 5 s on a baseline network.

---

## 7. Verify failed manual refresh preserves the prior catalog (US3, AC-2; FR-018, SC-005)

1. Simulate an upstream outage. The simplest way: temporarily edit `config/pricingSource.js` to point `pricingUrl` at `https://invalid.example.invalid/pricing.json`, restart the dev server, and re-open the **模型价格** tab.
2. Note the current "上次更新" timestamp and the current model count.
3. Click **立即刷新**.
4. Within ~10 s, expect:
    - A red error toast surfacing a human-readable failure reason (the upstream error message).
    - The "上次更新" timestamp UNCHANGED (does not advance to "just now").
    - The table remains populated with the previously loaded catalog (the bundled fallback is in effect — the cost calculator still works).
5. Restore `config/pricingSource.js` and restart.

**Cross-check** (out-of-band, optional): Issue a real Claude-relay request against the dev server during the simulated outage and confirm cost is still calculated (via `logs/claude-relay-*.log`). This confirms FR-018 — the cost-calculation hot path is not blocked or broken by the failed refresh.

---

## 8. Verify dark-mode + responsive breakpoints (FR-016)

1. Toggle the SPA theme via the existing theme toggle. Verify the model pricing tab renders cleanly in both light and dark mode (no white-on-white text, no missing borders).
2. Resize the browser to **1280 px** wide. Expect: all columns visible (模型名称, 输入, 输出, 缓存创建, 缓存读取, 上下文窗口).
3. Resize to **768 px** (tablet). Expect: cache and context-window columns may collapse per Tailwind `md:` / `lg:` breakpoints; 模型名称 / 输入 / 输出 stay visible.
4. Resize to **375 px** (mobile). Expect: 模型名称 / 输入 / 输出 still readable (may scroll horizontally if needed). Status card and refresh button still tappable. Search input not clipped.

**Expected**: No layout breakage at any of the three widths in either theme. Tab switching, search typing, and refresh remain functional.

---

## Wrap-up

After all 8 sections pass:

- `npm run lint` returns zero new errors.
- `npx prettier --check` passes on every modified file.
- `npm run cli status` reports the relay service healthy.
- `logs/claude-relay-*.log` contains an `info` entry for every successful manual refresh (`✅ Pricing data refreshed by <admin> — <message>`) and an `error` entry for every failure.

Record the results (pass / fail per section, with notes on any deviation) in the PR description so reviewers can audit acceptance without re-running the script themselves.
