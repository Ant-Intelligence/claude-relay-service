# Quickstart: Stable Account Type

**Branch**: `001-stable-account-type` | **Date**: 2026-03-06

## What Is a Stable Account?

A **stable account** is a Claude account scheduling mode that limits how many concurrent API-key conversations occupy the account at once. Unlike a shared account (pure load balancing) or a dedicated account (exclusive to one API key), a stable account uses an **inactivity threshold** to decide when a conversation slot is free: if no request has been made in the last N minutes, the slot is available for a new conversation.

This is ideal for accounts where you want to maintain a few long-running, stable conversations rather than many short parallel ones.

## How to Configure

1. In the admin dashboard, go to **Accounts → Claude Accounts** (or Console Accounts).
2. Create or edit an account.
3. Set **Account Type** to `稳定账户` (Stable).
4. Configure:
   - **最大会话数 (Max Sessions)**: How many simultaneous conversations this account can hold (default: 1).
   - **不活跃超时 (Inactivity Timeout, minutes)**: How long a conversation must be idle before its slot is available to a new conversation (default: 5 minutes).
5. Save.

## How Scheduling Works

- Stable accounts participate in the normal **shared pool** with the same priority ordering.
- When a new session starts, the scheduler checks how many of the account's conversation slots are **active** (had a request within the inactivity window). If all slots are active, the scheduler moves to the next account — no error is returned to the client.
- When a slot's last request was more than N minutes ago, it's considered **available**. A new conversation from any API key can enter that slot.
- Once a conversation is in progress on a stable account, it stays on that account for continuity — even if the slot has "timed out" in terms of capacity counting.

## Failure Behavior

If a stable account becomes unavailable (rate-limited, overloaded, etc.):
- The **requesting session only** has its mapping cleared and is rescheduled to another account in the same request.
- Other conversations on the same account are **not affected** — they discover the unavailability independently on their next request.

## Redis Keys Used

| Key | Purpose |
|-----|---------|
| `unified_claude_session_mapping:{sessionHash}` | Session → account mapping (now includes `lastActivity` timestamp) |
| `stable_account_sessions:{accountId}` | Reverse index: which sessions are on this stable account |

## Default Values

| Setting | Default |
|---------|---------|
| `maxStableSessions` | 1 |
| `stableInactivityMinutes` | 5 |
| Session mapping TTL | Same as `STICKY_SESSION_TTL_HOURS` (default 1 hour, reset on each request) |
