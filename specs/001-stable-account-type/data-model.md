# Data Model: Stable Account Type

**Branch**: `001-stable-account-type` | **Date**: 2026-03-06

---

## Extended Entities

### Claude Account (Official) — Extended

Redis key: `claude:account:{accountId}` (Hash)

New fields added to existing hash:

| Field | Type | Default | Validation | Notes |
|-------|------|---------|-----------|-------|
| `accountType` | String | `'shared'` | One of: `'shared'`, `'dedicated'`, `'group'`, `'stable'` | Existing field; `'stable'` is the new valid value |
| `maxStableSessions` | String (numeric) | `'1'` | Integer ≥ 1 | Only meaningful when `accountType === 'stable'`; stored as string (Redis hash convention) |
| `stableInactivityMinutes` | String (numeric) | `'5'` | Integer ≥ 0; 0 = no inactivity eviction | Only meaningful when `accountType === 'stable'`; stored as string |

**Backward compatibility**: Accounts without `maxStableSessions` / `stableInactivityMinutes` are unaffected (scheduler reads these only for `accountType === 'stable'`).

---

### Claude Console Account — Extended

Redis key: `claude_console_account:{accountId}` (Hash)

Same new fields as Claude Official above. Stored identically as strings.

---

### Session Mapping — Extended

Redis key: `unified_claude_session_mapping:{sessionHash}` (String/JSON)

Extended JSON value:

```json
{
  "accountId": "string",
  "accountType": "string",
  "lastActivity": 1709999999000
}
```

| Field | Type | Notes |
|-------|------|-------|
| `accountId` | String | Existing field |
| `accountType` | String | Existing field (e.g., `'claude-official'`, `'claude-console'`, `'bedrock'`, `'ccr'`) |
| `lastActivity` | Number (Unix ms) | **New field**. Set at request selection time. Absent in legacy mappings → treated as 0 (slot immediately "timed out"; safe default) |

**TTL**: Unchanged — uses `stickyTtlHours` (default 1h), reset on each successful request via existing `_extendSessionMappingTTL` logic.

---

### Stable Account Sessions (New)

Redis key: `stable_account_sessions:{accountId}` (Set)

| Element | Type | Notes |
|---------|------|-------|
| Member | String | Session hash (`sessionHash`) of each session currently mapped to this stable account |

**Lifecycle**:
- **Add**: `SADD stable_account_sessions:{accountId} {sessionHash}` when a new session is assigned to a stable account.
- **Remove**: `SREM stable_account_sessions:{accountId} {sessionHash}` when session mapping is deleted (account unavailable for this session) or when lazy cleanup detects the mapping has expired.
- **TTL**: None set. When the Set becomes empty, it auto-deletes in Redis. When counting slots, members whose session mapping no longer exists (expired) are lazily removed.
- **Slot count query**: `SMEMBERS stable_account_sessions:{accountId}` → batch `MGET unified_claude_session_mapping:{hash}` for each → parse JSON → filter by `lastActivity > now - stableInactivityMinutes * 60 * 1000` → count = active slots.

---

## State Transitions

### Stable Session Slot Lifecycle

```
[No mapping exists]
       │
       ▼ New request dispatched to stable account
[Mapping created: {accountId, accountType, lastActivity=now}]
[Added to stable_account_sessions:{accountId}]
       │
       ▼ Follow-up request within inactivity window
[lastActivity updated to now; TTL extended]
[Slot counted as ACTIVE in capacity check]
       │
       ├─► Inactive > stableInactivityMinutes
       │   [Slot counted as AVAILABLE in capacity check]
       │   [Follow-up from SAME session → still routed here, lastActivity refreshed]
       │   [New session from OTHER API key → slot allocated to them]
       │
       ├─► Mapping TTL expires (no requests for 1h)
       │   [Mapping auto-deleted by Redis]
       │   [stable_account_sessions entry lazily removed on next slot count]
       │
       └─► Account becomes unavailable for THIS session
           [This session's mapping deleted]
           [SREM from stable_account_sessions]
           [Request rescheduled to another account]
           [Other sessions' mappings unchanged]
```

---

## Slot Capacity Evaluation Algorithm

```
function countActiveSlots(accountId, stableInactivityMinutes):
  sessionHashes = SMEMBERS stable_account_sessions:{accountId}
  if sessionHashes is empty: return 0

  mappings = MGET [unified_claude_session_mapping:{h} for h in sessionHashes]

  activeCount = 0
  expiredHashes = []
  now = current timestamp (ms)
  threshold = now - stableInactivityMinutes * 60 * 1000

  for each (hash, mappingJSON) in zip(sessionHashes, mappings):
    if mappingJSON is null:
      expiredHashes.append(hash)   # mapping expired naturally
      continue
    mapping = JSON.parse(mappingJSON)
    lastActivity = mapping.lastActivity || 0
    if lastActivity > threshold:
      activeCount++
    # else: slot is available (timed out); do not count

  if expiredHashes is not empty:
    SREM stable_account_sessions:{accountId} expiredHashes  # lazy cleanup

  return activeCount
```

**Complexity**: O(n) where n = number of sessions ever assigned to the stable account (bounded by `maxStableSessions` in steady state, may temporarily spike if many expired entries accumulate).
