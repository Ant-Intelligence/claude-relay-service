# Research: Stable Account Type

**Branch**: `001-stable-account-type` | **Date**: 2026-03-06

---

## Decision 1: Reverse Index for Slot Counting

**Decision**: Add a new Redis Set `stable_account_sessions:{accountId}` as a reverse index from stable account → active session hashes. When counting active slots, iterate this Set, batch-fetch session mappings, filter by lastActivity, and lazily remove expired entries.

**Rationale**: Session mappings are keyed `unified_claude_session_mapping:{sessionHash}` (sessionHash → account). Counting how many sessions point to a given stable account requires a reverse lookup. A Redis Set per stable account is the minimal addition that avoids `KEYS` scans (prohibited by constitution). Lazy cleanup on read avoids dedicated housekeeping jobs.

**Alternatives Considered**:
- `KEYS unified_claude_session_mapping:*` scan — rejected: violates constitution's prohibition on KEYS commands; O(n) against all keys.
- Sorted Set with lastActivity as score — considered but a plain Set with per-entry mapping lookup is simpler; sorting is unnecessary since we only need count, not ordered iteration.
- Central hash `stable_slots:{accountId}` storing `{sessionHash: lastActivity}` — viable but introduces a second data structure that must be kept perfectly in sync; the reverse index + existing mapping is simpler and reuses existing TTL mechanics.

---

## Decision 2: lastActivity Field in Session Mapping

**Decision**: Extend the existing `unified_claude_session_mapping:{sessionHash}` JSON value from `{accountId, accountType}` to `{accountId, accountType, lastActivity}`. `lastActivity` is a Unix timestamp (ms) set at request selection time.

**Rationale**: The inactivity threshold check requires knowing when the last request for a session was made. Adding `lastActivity` to the existing session mapping JSON is the minimum change: no new Redis key, no schema migration needed (missing field → slot treated as active with timestamp 0, which is always "timed out" → safe default that opens the slot for a new session on first stable account allocation).

**Alternatives Considered**:
- Separate Redis key `stable_session_activity:{sessionHash}` — rejected: doubles the Redis round-trips; existing mapping already fetched on every request.
- Use Redis key TTL as proxy for activity — rejected: TTL is already used for session expiry (1h window), conflating it with 5-minute inactivity would break normal session renewal semantics.

**Update Timing**: lastActivity is updated at request **selection time** (when the scheduler assigns the account), not at response completion. This means "inactive for N minutes" = "no new requests dispatched for N minutes". This is simpler than hooking into relay service completion and sufficient for the use case.

---

## Decision 3: Slot Count Check Placement

**Decision**: Add stable-account slot capacity check inside the existing `_getAllAvailableAccounts()` loop for the shared pool (mirroring how `maxConcurrentTasks` is checked for Console accounts at line 754). The check runs before adding the account to the available list, so the scheduler sees a stable account as "at capacity" exactly like a concurrency-limited account.

**Rationale**: The spec requires "minimum impact" integration. The existing pattern at lines 707–765 (Console shared pool) already demonstrates how to check a per-account limit and skip the account if exceeded. Reusing this pattern requires ~10 lines of new code in the existing loop.

**Where check runs**:
1. `_getAllAvailableAccounts()` — filters stable accounts at capacity out of the candidate pool (affects new-session requests).
2. `_isAccountAvailable()` preflight check — ensures a stable account already bound to a session still passes availability check (session continuity; slot check skipped for existing sessions).

**Alternatives Considered**:
- New dedicated method `_selectStableAccount()` — rejected: premature abstraction; stable accounts share the same pool selection logic as shared accounts.
- Post-selection validation — rejected: would require re-running selection on failure; current pattern filters before selection.

---

## Decision 4: Session Cleanup Scope (Per-Session Lazy)

**Decision**: When a request finds its mapped stable account unavailable, delete only `unified_claude_session_mapping:{sessionHash}` for that session and remove that sessionHash from `stable_account_sessions:{accountId}`. Do not touch other sessions' mappings.

**Rationale**: User clarification. Other sessions discover unavailability independently. This avoids cross-session interference and keeps cleanup O(1) per request.

**Implementation Note**: The existing flow at line 299–310 already deletes a session mapping when the mapped account is unavailable (`_deleteSessionMapping` or direct `del` + fall-through). The only addition is a corresponding `SREM` from the reverse index.

---

## Decision 5: Account Type Validation Extension

**Decision**: Add `'stable'` as a valid `accountType` value in:
1. `admin.js` validation for Claude official and Claude Console account create/update endpoints.
2. `claudeAccountService.js` and `claudeConsoleAccountService.js` create/update methods.
3. `unifiedClaudeScheduler.js` shared pool filters (`accountType === 'shared' || !accountType` → `|| accountType === 'stable'`).

**New Fields**: `maxStableSessions` (integer ≥ 1, default 1) and `stableInactivityMinutes` (integer ≥ 0, default 5) added alongside existing account fields. Stored as strings in Redis hash (matching existing `maxConcurrentTasks` pattern).

**Backward Compatibility**: Existing accounts without these fields default to: non-stable type (field absent → not stable), so no existing account behavior changes.

---

## Redis Key Patterns Summary

| Key | Type | Purpose | TTL |
|-----|------|---------|-----|
| `unified_claude_session_mapping:{sessionHash}` | String (JSON) | Session → account mapping (extended with `lastActivity`) | stickyTtlHours (default 1h), reset on each request |
| `stable_account_sessions:{accountId}` | Set | Reverse index: stable account → active sessionHashes | No TTL (entries lazily cleaned; Set key deleted when empty) |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/unifiedClaudeScheduler.js` | Core scheduler changes: slot counting, reverse index management, lastActivity update, stable pool filter |
| `src/routes/admin.js` | Add `'stable'` to accountType validation; accept `maxStableSessions`, `stableInactivityMinutes` |
| `src/services/claudeAccountService.js` | Persist `maxStableSessions`, `stableInactivityMinutes`; accept `'stable'` accountType |
| `src/services/claudeConsoleAccountService.js` | Same as above |
| `web/admin-spa/src/components/accounts/AccountForm.vue` | Add `stable` option to accountType dropdown; show new fields conditionally |
