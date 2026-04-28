# Quickstart — Service Multiplier (服务倍率)

**Feature**: 001-service-multiplier
**Audience**: Developers verifying the implementation locally before merge.

## Prerequisites

- A working `dave` checkout that already runs (`npm run dev` succeeds and the admin SPA loads at `http://localhost:3000/admin-next/`).
- Redis reachable per `.env`.
- An existing admin login (`data/init.json` populated by `npm run setup`).
- At least one configured **Gemini** account on the dave branch and one valid API Key (so we can issue a real Gemini request through the relay).

## Walk-through

### 1. Configure a non-default rate

1. Log in to the admin SPA.
2. Open **System Settings → 服务倍率** (the new tab).
3. Confirm the page shows seven cards — Claude (base, 1.0), Codex, Gemini, Droid, Bedrock, Azure, CCR — each at 1.0.
4. Set Gemini to `0.5`.
5. Click **Save**.
6. Confirm the "last updated" line shows the current time and your admin username.
7. Refresh the page; confirm Gemini is still 0.5.

### 2. Verify hot-path behavior — no per-key override

1. Issue a Gemini API call through an API Key that has **no** `serviceRates` overrides.

   ```bash
   curl -sS http://localhost:3000/gemini/v1/models/gemini-1.5-pro:generateContent \
     -H "Authorization: Bearer cr_<your-api-key>" \
     -H "Content-Type: application/json" \
     -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
   ```

2. Wait ~2 s for usage to flush, then open the same key in the admin SPA's **API Keys** detail page (or call `GET /admin/api-keys/:keyId/cost-debug`).
3. Confirm the most recent usage record shows:
   - `realCost` ≈ the upstream USD cost.
   - `ratedCost` ≈ `realCost × 0.5`.
4. Open `GET /api/v1/usage` (or `/api/v1/key-info`) **with the user's API Key** (not admin) and confirm the response shows only the rated cost — `realCost` is **not** present in any key-facing field.

### 3. Verify per-key override

1. Edit the same API Key in the admin SPA. In the new **Service Rate Overrides** section, set Gemini = `0.8`. Save.
2. Re-issue the same Gemini API call.
3. Confirm the next usage record has `ratedCost ≈ realCost × 0.5 × 0.8 = realCost × 0.4`.

### 4. Verify Claude (baseline) is unaffected

1. Issue a Claude request through a Claude account.
2. Confirm `ratedCost == realCost` in the resulting usage record.

### 5. Verify validation

1. In **System Settings → 服务倍率**, set Gemini to `0` or `-1`.
2. Click **Save**.
3. Confirm a 400 / inline error and that the previously-saved 0.5 is still in storage.

### 6. Verify public endpoint

```bash
curl -sS http://localhost:3000/apiStats/service-rates | jq
```

Expected payload:

```json
{
  "rates": {
    "claude": 1.0,
    "codex": 1.0,
    "gemini": 0.5,
    "droid": 1.0,
    "bedrock": 1.0,
    "azure": 1.0,
    "ccr": 1.0
  },
  "baseService": "claude",
  "updatedAt": "2026-04-28T10:30:00.000Z"
}
```

`updatedBy` MUST NOT appear.

### 7. Verify hot-path fail-open

1. Stop Redis (`docker stop redis` or equivalent) for ~5 s.
2. Issue an API request — it should still succeed.
3. Check `logs/claude-relay-*.log`; confirm a `warn`-level entry mentioning the service-rates read failure and that the request was charged at `ratedCost == realCost`.
4. Restart Redis. Subsequent requests resume normal multiplier application within 60 s (the cache TTL).

### 8. Verify weekly cost limit consumes ratedCost

1. Edit an API Key and set `weeklyCostLimit` to a small value (e.g. $0.10).
2. Set the global Gemini multiplier to `0.5`.
3. Issue Gemini requests until the rate limit triggers.
4. Confirm via `usage:cost:weekly:total:{keyId}` that the accumulated value tracks `ratedCost`, not `realCost`.

## Cleanup

- Reset all global rates back to 1.0 in the admin SPA when finished.
- Remove any per-key overrides you set during testing.
- Restore any `weeklyCostLimit` you adjusted.

## What "good" looks like

- All seven scenarios above pass.
- `npm run lint` reports zero errors.
- `npx prettier --check` reports no formatting drift on modified files.
- `npm test` reports no regressions.
- Manual SPA inspection in dark mode shows the new tab with correct colours and contrast.
- Manual responsive check (≤ 375 px width, e.g. iPhone SE) shows the cards stacking cleanly.
