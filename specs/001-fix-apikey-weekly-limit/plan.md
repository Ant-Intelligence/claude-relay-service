# Implementation Plan: Fix API Key Weekly Cost Limit (weeklyCostLimit)

**Branch**: `001-fix-apikey-weekly-limit` | **Date**: 2026-02-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-fix-apikey-weekly-limit/spec.md`

## Summary

Fix the `weeklyCostLimit` field being silently dropped in the CREATE
and BATCH CREATE API key endpoints in `src/routes/admin.js`. The field
must be added to the `req.body` destructuring and passed through to
`apiKeyService.generateApiKey()`. The UPDATE endpoint already works
correctly. No frontend or service layer changes are needed.

## Technical Context

**Language/Version**: Node.js 18+
**Primary Dependencies**: Express.js 4.18.2, ioredis 5.3.2
**Storage**: Redis (existing infrastructure)
**Testing**: Manual verification via admin UI and API
**Target Platform**: Linux server / Docker
**Project Type**: Single backend service with web admin SPA
**Performance Goals**: N/A (bug fix, no performance impact)
**Constraints**: Backward compatible — only adding missing field pass-through
**Scale/Scope**: 1 file, 2 locations (single create + batch create)

## Constitution Check

*GATE: Must pass before implementation. Constitution v1.0.0.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Security First | ✅ PASS | No new credentials stored; existing auth chain unchanged |
| II. Service Modularity | ✅ PASS | Change is in route layer only; service already supports field |
| III. Backward Compatibility | ✅ PASS | Adding field pass-through; no existing behavior changed |
| IV. Observability | ✅ PASS | No new logging needed; existing usage tracking covers this |
| V. Spec-Driven Development | ✅ PASS | spec.md and plan.md created |
| VI. Simplicity & Minimal Change | ✅ PASS | Minimum possible change: add 1 line to destructuring + 1 line to function call, twice |
| VII. Resilience & Fault Tolerance | ✅ PASS | Field defaults to 0 when undefined; no new failure modes |

## Project Structure

### Documentation (this feature)

```text
specs/001-fix-apikey-weekly-limit/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # N/A (no unknowns to research)
├── data-model.md        # N/A (no new data models)
├── quickstart.md        # Verification steps
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
src/
└── routes/
    └── admin.js         # MODIFY: 2 locations (create + batch create)
```

**Structure Decision**: Single file modification. The route handler
at `src/routes/admin.js` is the only file that needs changes.
`src/routes/admin/apiKeys.js` exists but is NOT imported by the app
and is effectively dead code — it is NOT in scope for this fix.

## Complexity Tracking

> No constitution violations. No complexity justification needed.

## Implementation Detail

### Change 1: Single CREATE endpoint (line 1112)

**File**: `src/routes/admin.js`

**Location A — Destructuring** (lines 1114-1142):
Add `weeklyCostLimit` to the destructured fields from `req.body`,
after `weeklyOpusCostLimit` (line 1136).

**Location B — Service call** (lines 1270-1298):
Add `weeklyCostLimit` to the `apiKeyService.generateApiKey()` call,
after `weeklyOpusCostLimit` (line 1292).

### Change 2: BATCH CREATE endpoint (line 1309)

**File**: `src/routes/admin.js`

**Location A — Destructuring** (lines 1311-1340):
Add `weeklyCostLimit` to the destructured fields from `req.body`,
after `weeklyOpusCostLimit` (line 1334).

**Location B — Service call** (lines 1371-1399):
Add `weeklyCostLimit` to the `apiKeyService.generateApiKey()` call,
after `weeklyOpusCostLimit` (line 1393).

### What NOT to change

- **UPDATE endpoint** (line 1629): Already works correctly.
  `weeklyCostLimit` is destructured (line 1655) and validated/assigned
  (lines 1832-1839).
- **Frontend**: CreateApiKeyModal.vue, EditApiKeyModal.vue, and
  ApiKeysView.vue all handle `weeklyCostLimit` correctly already.
- **Service layer**: `apiKeyService.generateApiKey()` already accepts
  `weeklyCostLimit` (line 150) and stores it (line 190).

## Verification

After applying the fix:

1. **Create via UI**: Open admin panel → Create API Key → Set weekly
   cost limit to $200 → Submit → Verify key list shows $200 limit
2. **Create via API**: `POST /admin/api-keys` with
   `{ "name": "test", "weeklyCostLimit": 500 }` → GET the key →
   Verify `weeklyCostLimit` equals 500
3. **Batch create**: `POST /admin/api-keys/batch` with
   `{ "baseName": "batch", "count": 2, "weeklyCostLimit": 300 }` →
   Verify all created keys have `weeklyCostLimit` = 300
4. **Edit unchanged**: Edit an existing key → Change weekly limit →
   Save → Verify it still works (regression check)
5. **Default behavior**: Create key without setting weekly limit →
   Verify `weeklyCostLimit` defaults to 0
