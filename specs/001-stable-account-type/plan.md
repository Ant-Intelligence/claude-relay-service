# Implementation Plan: Stable Account Type

**Branch**: `001-stable-account-type` | **Date**: 2026-03-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-stable-account-type/spec.md`

---

## Summary

Add a fourth Claude account scheduling mode — **stable** — that limits how many concurrent API-key sessions occupy a single account based on inactivity tracking rather than raw request concurrency. A stable account participates in the shared pool with existing priority ordering; being at session capacity is treated as a transparent scheduling constraint (no error). When a session discovers its mapped stable account is unavailable, only that session's own mapping is cleared (per-session lazy cleanup).

**Technical approach**: Extend the existing session mapping JSON (`unified_claude_session_mapping`) with a `lastActivity` timestamp field. Introduce a Redis Set reverse index (`stable_account_sessions:{accountId}`) to count active slots. Add slot-capacity check inside the existing shared pool selection loop in `unifiedClaudeScheduler.js`. Add `'stable'` to `accountType` validation in admin routes and persist two new account fields (`maxStableSessions`, `stableInactivityMinutes`).

---

## Technical Context

**Language/Version**: Node.js 18+ (ES2020+)
**Primary Dependencies**: Express.js 4.18.2, ioredis 5.3.2, winston 3.11.0 (all existing)
**Storage**: Redis — existing infrastructure; two key patterns affected: `unified_claude_session_mapping:*` (extended JSON), new `stable_account_sessions:*` (Set)
**Testing**: Jest + SuperTest (existing); manual CLI verification (`npm run cli status`)
**Target Platform**: Linux server (Docker Compose)
**Project Type**: Web service (relay middleware)
**Performance Goals**: Slot count check must complete in O(n) where n = maxStableSessions (bounded); p99 overhead < 5ms per scheduling decision
**Constraints**: MUST NOT use KEYS command; MUST gracefully handle accounts without new fields (backward compat); MUST NOT alter non-stable account behavior
**Scale/Scope**: Modifies 5 files; adds ~150 lines of new code; no new services or route files

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Security First | ✅ Pass | No new sensitive data stored; `maxStableSessions` and `stableInactivityMinutes` are non-sensitive configuration integers |
| II. Service Modularity | ✅ Pass | Changes confined to `unifiedClaudeScheduler.js` (shared scheduler), admin routes, and account services. No new service files created |
| III. Backward Compatibility | ✅ Pass | Accounts without new fields default to non-stable behavior. Existing `_setSessionMapping` output gains `lastActivity` field; existing consumers only read `accountId` and `accountType` — they ignore unknown fields in JSON |
| IV. Observability | ✅ Pass | Slot capacity checks logged at debug level; warnings logged when stable account is skipped due to capacity |
| V. Spec-Driven Development | ✅ Pass | Full speckit workflow followed: specify → clarify → plan |
| VI. Simplicity & Minimal Change | ✅ Pass | No new service files, no new route files, no new abstractions. Reuses existing session mapping and concurrency check patterns |
| VII. Resilience & Fault Tolerance | ✅ Pass | Lazy cleanup of expired Set entries; per-session unavailability handling; stable account at capacity treated identically to concurrency limit (account skipped, not error thrown) |

**Post-design re-check**: All gates pass. The reverse index Set (`stable_account_sessions:{accountId}`) is a minimal addition that avoids KEYS scans. Lazy cleanup prevents memory leaks without a dedicated background job.

---

## Project Structure

### Documentation (this feature)

```text
specs/001-stable-account-type/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── admin-api.md     # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (files modified)

```text
src/
├── services/
│   ├── unifiedClaudeScheduler.js   # Core: slot counting, reverse index, lastActivity
│   ├── claudeAccountService.js      # Persist maxStableSessions, stableInactivityMinutes
│   └── claudeConsoleAccountService.js  # Same as above
└── routes/
    └── admin.js                     # Add 'stable' to accountType validation; new fields

web/admin-spa/src/
└── components/accounts/
    └── AccountForm.vue              # Add 'stable' option; show new config fields
```

No new files in `src/` are created. The reverse index is a new Redis key pattern, not a new code module.

---

## Implementation Phases

### Phase A: Core Scheduler (P1 — Required for everything)

**Target**: `src/services/unifiedClaudeScheduler.js`

**A1 — Extend session mapping with lastActivity**

Modify `_setSessionMapping(sessionHash, accountId, accountType)` (lines 1146–1154):
- Add `lastActivity: Date.now()` to the JSON value stored via `setex`.
- No change to the Redis key or TTL.

Modify `_getSessionMapping(sessionHash)` (lines 1129–1143):
- Already returns the parsed JSON; `lastActivity` is now available in the returned object.

**A2 — Update lastActivity on session reuse**

In the sticky session reuse path (line 306, where `_extendSessionMappingTTL` is called):
- After extending TTL, also update `lastActivity` in the mapping value: rewrite the JSON value with `Date.now()` while resetting the TTL.
- Implement as a new private method `_updateSessionActivity(sessionHash, mapping)` that calls `setex` with updated JSON + full TTL. Replaces the separate `_extendSessionMappingTTL` call at this location.

**A3 — Add `_countActiveStableSessionSlots(accountId, stableInactivityMinutes)` method**

New private method. Algorithm (see data-model.md):
1. `SMEMBERS stable_account_sessions:{accountId}` — get all session hashes for this account.
2. Batch `MGET` all session mapping keys.
3. Parse each JSON; check `lastActivity > now - stableInactivityMinutes * 60000`.
4. Count active slots; lazily `SREM` entries whose mapping no longer exists (expired naturally).
5. Return active slot count.

**A4 — Add reverse index management**

New private method `_addToStableAccountSessions(accountId, sessionHash)`:
- `SADD stable_account_sessions:{accountId} {sessionHash}`

New private method `_removeFromStableAccountSessions(accountId, sessionHash)`:
- `SREM stable_account_sessions:{accountId} {sessionHash}`
- After SREM, check remaining count (SCARD); if 0, `DEL stable_account_sessions:{accountId}`.

**A5 — Integrate stable capacity check in shared pool selection**

In `_getAllAvailableAccounts()`, for the Claude official shared pool loop (around line 595) and the Console shared pool loop (around line 667):
- After the existing `accountType === 'shared'` filter, add: `|| account.accountType === 'stable'` to include stable accounts in the pool.
- After including a stable account, check capacity: if `account.accountType === 'stable'`:
  - `maxStableSessions = parseInt(account.maxStableSessions) || 1`
  - `stableInactivityMinutes = parseInt(account.stableInactivityMinutes) ?? 5`
  - `activeSlots = await _countActiveStableSessionSlots(account.accountId, stableInactivityMinutes)`
  - If `activeSlots >= maxStableSessions` → skip this account (log at debug level: "stable account {id} at capacity {activeSlots}/{maxStableSessions}").

**A6 — Create session mapping for stable account (with reverse index)**

In the session mapping creation path (lines 372–376, after account selected and sessionHash present):
- After calling `_setSessionMapping(...)`, if the selected account is stable: call `_addToStableAccountSessions(accountId, sessionHash)`.

**A7 — Per-session cleanup on unavailability**

In the session reuse path where mapped account is found unavailable (around line 299–310):
- After deleting the session mapping (existing `del` call), if the account type was stable: call `_removeFromStableAccountSessions(accountId, sessionHash)`.
- This covers the case where sticky session points to a now-unavailable stable account.

**A8 — Skip slot capacity check for existing session (session continuity)**

In `_isAccountAvailable()` preflight (around line 915), when checking a stable account:
- Do NOT apply slot capacity check here — this function is called when an existing session mapping is being validated, and session continuity takes priority (FR-006).
- Only the `_getAllAvailableAccounts()` path (new sessions) enforces slot capacity.

---

### Phase B: Admin API (P2 — Required for configuration)

**Target**: `src/routes/admin.js`

**B1 — Claude official account create/update**

In `POST /admin/claude-accounts` validation (around line 3076):
- Add `'stable'` to the valid accountType values: `['shared', 'dedicated', 'group', 'stable']`.
- Accept and validate `maxStableSessions` (optional integer ≥ 1; default 1) and `stableInactivityMinutes` (optional integer ≥ 0; default 5).

In `PUT /admin/claude-accounts/:id` (update endpoint):
- Same validation additions.

**B2 — Claude Console account create/update**

In `POST /admin/claude-console-accounts` validation (around line 3637):
- Add `'stable'` to valid accountType values.
- Accept and validate `maxStableSessions` and `stableInactivityMinutes` (same as B1).

In `PUT /admin/claude-console-accounts/:id`:
- Same.

---

### Phase C: Account Services (P2 — Required for persistence)

**Target**: `src/services/claudeAccountService.js` and `src/services/claudeConsoleAccountService.js`

**C1 — claudeAccountService.js**

In `createAccount()` (line 111–147):
- Accept `maxStableSessions` and `stableInactivityMinutes` from input.
- Store in Redis hash alongside existing fields: `maxStableSessions: (maxStableSessions || 1).toString()`, `stableInactivityMinutes: (stableInactivityMinutes ?? 5).toString()`.

In `updateAccount()`:
- Same: accept and persist the two new fields.

In account retrieval (wherever account data is read from Redis hash into object):
- Parse `maxStableSessions` and `stableInactivityMinutes` as integers (matching existing `maxConcurrentTasks` pattern).

**C2 — claudeConsoleAccountService.js**

Same changes as C1 mirrored for Console accounts.

---

### Phase D: Frontend (P2 — Required for SC-005)

**Target**: `web/admin-spa/src/components/accounts/AccountForm.vue`

**D1 — Add 'stable' to accountType options**

In both Claude official and Console account form sections, the `accountType` `<select>` or radio group:
- Add option: `{ value: 'stable', label: '稳定账户' }` (or English equivalent per existing UI language).

**D2 — Conditional stable configuration fields**

Show the following fields only when `form.accountType === 'stable'`:
- **maxStableSessions**: numeric input, min=1, label e.g. "最大会话数", default 1.
- **stableInactivityMinutes**: numeric input, min=0, label e.g. "不活跃超时(分钟)", default 5.

Place these fields adjacent to the existing `maxConcurrentTasks` field (Console) or the existing accountType-conditional group ID field (Official).

**D3 — Form data initialization and submission**

In the data object initialization:
- `maxStableSessions: props.account?.maxStableSessions || 1`
- `stableInactivityMinutes: props.account?.stableInactivityMinutes ?? 5`

In the form submission builders (`buildClaudeAccountData()` and equivalent for Console):
- Include `maxStableSessions` and `stableInactivityMinutes` in the payload when `accountType === 'stable'`.

**D4 — Dark mode and responsive design**

Apply the same Tailwind CSS classes as adjacent form fields. Use `dark:` prefixed variants to match project convention.

---

## Complexity Tracking

No constitution violations. No complexity justification table needed.

---

## Verification Checklist

After implementation:

1. `npm run lint` — zero errors.
2. `npx prettier --check src/services/unifiedClaudeScheduler.js src/routes/admin.js src/services/claudeAccountService.js src/services/claudeConsoleAccountService.js` — passes.
3. Manual test: create stable account via admin UI, send two requests from different API keys with different session hashes, verify second is rescheduled when first is active within inactivity window.
4. Manual test: resume a session after 6+ minutes of inactivity; verify it routes back to the same stable account.
5. Manual test: send request to stable account session; simulate account unavailability; verify only that session's mapping is cleared, other sessions' mappings remain.
6. `npm run cli status` — no unexpected errors.
7. Check `logs/claude-relay-*.log` for stable capacity log lines at debug level.
