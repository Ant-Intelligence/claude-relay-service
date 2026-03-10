# Feature Specification: Stable Account Type

**Feature Branch**: `001-stable-account-type`
**Created**: 2026-03-06
**Status**: Draft
**Input**: User description: "目前claude帐号已经有3种账户类型：共享账户，专属账户，分组调度。我想再增加账户类型稳定帐号。稳定帐号默认只支持一个会话，默认所有会话超过5分钟不活跃就接受调度新api key请求进入，即新建会话，超时的会话重新活跃就同时处理，直到帐号不可用就结束所有会话，调度到别的帐号，如此维持同时只有几个会话并行。改调度应该以最小影响加入到现有的调度算法，稳定帐号参与api key共享池调度，遵循现有优先级策略，类似并发限制，受限不是异常."

## Overview

Claude accounts currently support three scheduling modes: shared pool (any API key can use), dedicated (exclusive to one API key), and group scheduling (flexible pool within a group). This feature adds a fourth mode: **Stable Account**, which provides controlled, persistent session management for accounts that require stable, long-running conversations while limiting total concurrent load.

A stable account limits how many simultaneous API-key sessions occupy it at a given moment. A session "slot" is considered available again after its last activity exceeds an inactivity threshold (default: 5 minutes). Reactivated timed-out sessions continue to be served alongside newer sessions. When a session's request discovers the stable account is unavailable, only that session's own mapping is cleared and the request is rescheduled — other sessions on the same stable account are unaffected and discover unavailability independently on their next request. This behavior is analogous to how concurrency limits work: being at capacity is a scheduling constraint, not an error.

---

## Clarifications

### Session 2026-03-06

- Q: When a stable account becomes unavailable, should the system clear all sessions mapped to it or only the requesting session's own mapping? → A: Only the requesting session's own mapping should be cleared; other API keys' sessions on the same stable account are unaffected and discover unavailability lazily on their own next request.
- Q: What is the maximum lifetime of a stable account session mapping? → A: Use the same TTL as the existing sticky session (default 1h, configurable via STICKY_SESSION_TTL_HOURS), reset on each successfully routed request; session mapping expires naturally if no requests arrive within that window.

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Schedule Into a Stable Account (Priority: P1)

An API key user sends a request that is dispatched to a stable account from the shared pool. The stable account has a free slot (active sessions below the inactivity-expired threshold). The session is recorded and subsequent requests from the same session are routed to the same account.

**Why this priority**: This is the core flow — the stable account must first be selectable from the shared pool before any other behavior can work.

**Independent Test**: Configure one stable account in the system. Send a fresh request with a new session hash. Verify it is scheduled to the stable account and a session mapping is created.

**Acceptance Scenarios**:

1. **Given** a stable account is active and has zero ongoing sessions, **When** a new API key request arrives with a session hash, **Then** the scheduler selects the stable account, creates a session mapping, and returns a successful response.
2. **Given** a stable account has reached its max-active-sessions limit (all slots occupied by recently-active sessions), **When** a new API key request arrives, **Then** the scheduler bypasses the stable account (treats it as at-capacity) and selects the next available account in the shared pool without returning an error to the caller.
3. **Given** a stable account has a session whose last activity exceeded the inactivity threshold, **When** a new API key request arrives, **Then** the scheduler considers that slot available, assigns the new session, and begins routing to the stable account.

---

### User Story 2 - Continue an Existing Stable Session (Priority: P1)

A user's ongoing conversation (sticky session) resumes after a pause. Whether or not the pause exceeded the inactivity threshold, the resumed conversation continues to be served by the same stable account as long as that account is available.

**Why this priority**: Session continuity is equally critical to initial scheduling — it is the primary reason to use stable accounts.

**Independent Test**: Establish a session on a stable account. Wait beyond the inactivity threshold. Send a follow-up request with the same session hash. Verify it routes to the same stable account and the session mapping is preserved.

**Acceptance Scenarios**:

1. **Given** an existing session is mapped to a stable account and the last activity is within the inactivity threshold, **When** a follow-up request arrives with the same session hash, **Then** it is routed directly to the same stable account without re-evaluation of capacity.
2. **Given** an existing session is mapped to a stable account and the last activity exceeded the inactivity threshold (slot now considered "available"), **When** a follow-up request arrives with the same session hash, **Then** it is still routed to the same stable account (session remains valid), and the slot may simultaneously accept a new session from another API key.
3. **Given** a stable account becomes unavailable (error state, rate limit, overload) while sessions are active, **When** a follow-up request arrives for a session mapped to that account, **Then** only that session's own mapping is cleared and the request is rescheduled to the next available account; other sessions on the same stable account remain mapped until they encounter unavailability on their own next request.

---

### User Story 3 - Configure Stable Account Parameters (Priority: P2)

An administrator configures a Claude account as a "stable" account via the management interface or admin API, setting the maximum number of concurrent active sessions and the inactivity threshold.

**Why this priority**: Without configuration capability, the feature cannot be adopted. Comes after core scheduling is validated.

**Independent Test**: Create or update a Claude account with `accountType = stable`, `maxStableSessions = 2`, and `stableInactivityMinutes = 5`. Verify these settings are persisted and respected by the scheduler.

**Acceptance Scenarios**:

1. **Given** an administrator sets an account type to "stable" with a max session count of 2 and inactivity threshold of 5 minutes, **When** the configuration is saved, **Then** the scheduler uses those parameters for all future scheduling decisions involving that account.
2. **Given** a stable account is configured with `maxStableSessions = 1` (the default), **When** one session is active and within the inactivity window, **Then** no additional sessions are scheduled to that account until the existing session's inactivity threshold is exceeded.
3. **Given** no explicit inactivity threshold is configured, **When** the scheduler evaluates session slots, **Then** it defaults to a 5-minute inactivity threshold.

---

### User Story 4 - Stable Account Failure Triggers Per-Session Lazy Cleanup (Priority: P2)

When a stable account becomes unavailable (overloaded, rate-limited, error state), each session discovers this independently: on its next request, only its own mapping is cleared and the request is rescheduled. Other sessions on the same stable account are not proactively affected.

**Why this priority**: Ensures system resilience — stable sessions must not remain stuck on a failed account, but cleanup is scoped to the requesting session to avoid interfering with other API keys' sessions.

**Independent Test**: Map two sessions (from different API keys) to a stable account. Trigger account unavailability. Send a request for session A only. Verify session A is rescheduled to a different account and its mapping is cleared, while session B's mapping still exists until it makes its own next request.

**Acceptance Scenarios**:

1. **Given** two sessions are mapped to a stable account and the account becomes unavailable, **When** only session A makes a request, **Then** session A's mapping is deleted and the request is rescheduled to another account; session B's mapping is unchanged.
2. **Given** two sessions are mapped to a stable account and the account becomes unavailable, **When** both sessions make requests (in any order), **Then** each session independently clears its own mapping and is rescheduled; after both requests complete, no mappings to the unavailable account remain.
3. **Given** a stable account recovers after an unavailability period, **When** a new request arrives (with no stale session mapping), **Then** the stable account is again eligible to accept new sessions.

---

### Edge Cases

- What happens when all stable accounts are at capacity and no other shared accounts are available? The scheduler returns the same "no available accounts" result it would for any other account type — not a stable-specific error.
- What happens if a stable account's inactivity threshold is set to 0 minutes? Treat 0 as "no inactivity eviction" — effectively a concurrency-limited shared account where all session slots stay permanently occupied once filled.
- What happens when a timed-out session and a new session both become active simultaneously? Both coexist on the stable account. The actual concurrent session count temporarily exceeds `maxStableSessions` until one of the sessions becomes inactive again. This is intentional and expected — `maxStableSessions` is a desired session count (soft limit) that only gates new session admission. When all coexisting sessions remain active, their `lastActivity` timestamps are refreshed, they all count as active slots, and no further new sessions are admitted until one becomes inactive again. No existing session is ever forcibly evicted.
- What if `maxStableSessions` is set higher than the account's natural concurrency limit? The natural per-request concurrency limit (`maxConcurrentTasks`) still applies independently; `maxStableSessions` controls session-level slot management only.
- What if a request arrives without a session hash? Requests without session hashes cannot create stable session slots. The stable account may still be selected for the request, but no slot is claimed and no session mapping is persisted.

---

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST support a new account type value `stable` for Claude accounts, alongside existing types.
- **FR-002**: Stable accounts MUST participate in the shared pool scheduling process, following existing priority and last-used-time ordering.
- **FR-003**: Stable accounts MUST track active sessions by counting session mappings whose last activity is within the configured inactivity threshold.
- **FR-004**: The scheduler MUST refuse new session admission (skip the account without error) when the count of recently-active session slots equals or exceeds `maxStableSessions`. This is a soft limit controlling new session entry only — existing sessions that reactivate after inactivity are not rejected.
- **FR-005**: The scheduler MUST consider a session slot "available" when the session's last activity timestamp exceeds the inactivity threshold, even if a session mapping still exists for that session.
- **FR-006**: When a follow-up request arrives for an existing session mapped to a stable account, the scheduler MUST continue routing to that account regardless of whether the slot would be counted as "available" (session continuity takes priority over capacity enforcement).
- **FR-007**: When a request discovers its mapped stable account is unavailable, the system MUST delete only that requesting session's own mapping and reschedule the current request; session mappings belonging to other API keys on the same stable account MUST NOT be touched.
- **FR-008**: Each stable account MUST be configurable with a `maxStableSessions` value (default: 1) and a `stableInactivityMinutes` value (default: 5 minutes).
- **FR-009**: The system MUST update the last-activity timestamp for a stable account's session mapping on every successfully routed request, and MUST reset the mapping's TTL to the standard sticky session TTL (default 1 hour, configurable via `STICKY_SESSION_TTL_HOURS`) at the same time.
- **FR-010**: Being at the stable-session capacity limit MUST NOT cause an error response to the API key user; it MUST be treated as a transparent scheduling constraint identical in behavior to concurrency limits.
- **FR-011**: Stable account scheduling changes MUST NOT alter the behavior of shared, dedicated, or group account types.

### Key Entities

- **Stable Account**: A Claude account (official, console, or bedrock) with `accountType = stable`, extended with `maxStableSessions` (integer ≥ 1, default 1) and `stableInactivityMinutes` (integer ≥ 0, default 5) configuration fields.
- **Stable Session Slot**: A session mapping entry on a stable account, containing the session hash, mapped account ID, and last-activity timestamp. A slot is "active" if its last-activity is within `stableInactivityMinutes`; "available" (evictable) if it has timed out. The mapping expires automatically after the standard sticky session TTL (default 1h) if no further requests arrive; each successful request resets this TTL.
- **Session Slot Capacity**: The count of active (non-timed-out) session slots on a stable account, used solely as a new-session admission gate. When this count equals `maxStableSessions`, no **new** sessions can enter the account until a slot times out. Note: the actual concurrent session count may temporarily exceed `maxStableSessions` when previously inactive sessions reactivate — this is expected and by design.

---

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A stable account configured with `maxStableSessions = 1` routes a second concurrent session to a different account within normal request latency (no increased delay vs. other scheduling decisions).
- **SC-002**: A resumed session that exceeded the inactivity threshold continues to be served by the same stable account with no interruption, while a new session may begin using the same account simultaneously.
- **SC-003**: When a stable account becomes unavailable, each session discovers this on its own next request, clears only its own mapping, and is rescheduled within that same request cycle (no individual session remains stuck on the failed account across two consecutive requests from that session).
- **SC-004**: Adding stable account scheduling does not measurably degrade scheduling latency for shared, dedicated, or group account types under equivalent load.
- **SC-005**: An administrator can configure a stable account and observe it accepting, holding, and releasing sessions via the management dashboard without additional developer intervention.

---

## Assumptions

- The existing sticky session mechanism is extended to store last-activity timestamps for stable session tracking; no entirely new Redis data structure is required beyond what is already used for session mappings.
- "Inactivity" is measured by the timestamp of the most recent successfully routed request, not by external heartbeat or client signal.
- `maxStableSessions` is a per-account configuration; the global default (1) is used when the field is absent.
- Stable accounts do not conflict with API Key-level dedicated bindings (`claudeAccountId`); if an API key is explicitly bound to a stable account, the dedicated-binding logic takes precedence as it does today.
- The feature applies to the same underlying account platforms that currently support `shared` type (claude-official, claude-console, bedrock); it does not introduce new platform support.
- Token refresh, proxy configuration, and error-handling behavior remain unchanged for stable accounts.
