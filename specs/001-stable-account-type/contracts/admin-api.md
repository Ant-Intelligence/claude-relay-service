# Admin API Contract: Stable Account Type

**Branch**: `001-stable-account-type` | **Date**: 2026-03-06

This document describes only the **delta** from existing API contracts. All existing request/response fields are unchanged.

---

## Claude Official Account Endpoints

### POST /admin/claude-accounts

**Changed**: `accountType` now accepts `'stable'` as a valid value.

**New optional fields** (only meaningful when `accountType === 'stable'`):

| Field | Type | Default | Validation |
|-------|------|---------|-----------|
| `maxStableSessions` | integer | `1` | ≥ 1 |
| `stableInactivityMinutes` | integer | `5` | ≥ 0 |

**Request body example** (stable account):
```json
{
  "name": "My Stable Account",
  "accountType": "stable",
  "maxStableSessions": 2,
  "stableInactivityMinutes": 5,
  "claudeAiOauth": { ... },
  "proxy": { ... }
}
```

**Response**: Same structure as existing; includes `maxStableSessions` and `stableInactivityMinutes` in returned account object.

---

### PUT /admin/claude-accounts/:id

Same delta as POST: `accountType` accepts `'stable'`; `maxStableSessions` and `stableInactivityMinutes` are updatable.

---

## Claude Console Account Endpoints

### POST /admin/claude-console-accounts

**Changed**: `accountType` now accepts `'stable'` as a valid value.

**New optional fields** (only meaningful when `accountType === 'stable'`):

| Field | Type | Default | Validation |
|-------|------|---------|-----------|
| `maxStableSessions` | integer | `1` | ≥ 1 |
| `stableInactivityMinutes` | integer | `5` | ≥ 0 |

---

### PUT /admin/claude-console-accounts/:id

Same delta as POST above.

---

## No Changes To

- All relay endpoints (`/api/v1/messages`, `/claude/v1/messages`, etc.)
- Authentication middleware
- API Key endpoints
- User management endpoints
- Gemini, OpenAI, Bedrock, Azure, Droid, CCR account endpoints
- Health and metrics endpoints

---

## Scheduler Behavior Contract (Internal)

This is not an HTTP API but documents the observable behavior contract for the scheduling system:

| Scenario | Expected Behavior |
|----------|------------------|
| New request, stable account has free slot | Account selected; session mapping created with `lastActivity=now`; sessionHash added to reverse index |
| New request, stable account at capacity (all slots active within inactivity window) | Account skipped; no error; next account in shared pool selected |
| New request, stable account has timed-out slot | Slot counted as available; account selected; new session mapping created |
| Follow-up request, mapped stable account available | Routed to same account; `lastActivity` updated; TTL extended |
| Follow-up request, mapped stable account unavailable | Own session mapping deleted; removed from reverse index; rescheduled in same request cycle |
| Request without sessionHash to stable account | Account may be selected; no slot claimed; no reverse index entry added |
