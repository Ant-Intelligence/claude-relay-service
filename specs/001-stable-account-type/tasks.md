# Tasks: Stable Account Type

**Input**: Design documents from `specs/001-stable-account-type/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/admin-api.md ✅, quickstart.md ✅

**Tests**: No test tasks generated (not requested in spec).

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete task dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify starting state; no new files to create.

- [X] T001 Read and understand `src/services/unifiedClaudeScheduler.js` session mapping methods: `_setSessionMapping` (lines 1146–1154), `_getSessionMapping` (lines 1129–1143), `_extendSessionMappingTTL` (lines 1185–1226), and the sticky-session reuse path (lines 286–320)
- [X] T002 [P] Read `src/routes/admin.js` accountType validation blocks for Claude official (around line 3076) and Claude Console (around line 3637) account create/update endpoints
- [X] T003 [P] Read `src/services/claudeAccountService.js` `createAccount()` and `updateAccount()` to understand field persistence pattern (lines 81–228)
- [X] T004 [P] Read `src/services/claudeConsoleAccountService.js` `createAccount()` and `updateAccount()` for the same pattern
- [X] T005 [P] Read `web/admin-spa/src/components/accounts/AccountForm.vue` accountType selector and form-data initialization sections (around lines 644–720, 3920–3975, 4531–4681)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extend the session mapping JSON schema and Redis reverse index infrastructure — these are required by every subsequent user story phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 In `src/services/unifiedClaudeScheduler.js`, extend `_setSessionMapping(sessionHash, accountId, accountType)` (lines 1146–1154) to include `lastActivity: Date.now()` in the stored JSON value. The key, TTL, and `setex` call remain unchanged; only the JSON payload gains the new field.
- [X] T007 In `src/services/unifiedClaudeScheduler.js`, add private method `_addToStableAccountSessions(accountId, sessionHash)` that executes `SADD stable_account_sessions:{accountId} {sessionHash}` via the Redis client. Place after `_setSessionMapping`.
- [X] T008 In `src/services/unifiedClaudeScheduler.js`, add private method `_removeFromStableAccountSessions(accountId, sessionHash)` that executes `SREM stable_account_sessions:{accountId} {sessionHash}`; after SREM, if `SCARD` returns 0, `DEL` the Set key. Place after `_addToStableAccountSessions`.
- [X] T009 In `src/services/unifiedClaudeScheduler.js`, add private method `_countActiveStableSessionSlots(accountId, stableInactivityMinutes)` implementing the algorithm from `data-model.md`: `SMEMBERS` → batch `MGET` all mapping keys → parse JSON → filter by `lastActivity > now - stableInactivityMinutes * 60000` → lazily `SREM` expired entries → return active count. Place after `_removeFromStableAccountSessions`.
- [X] T010 Run `npx prettier --write src/services/unifiedClaudeScheduler.js` and verify `npm run lint` passes with zero errors after Phase 2 changes.

**Checkpoint**: Session mapping now carries `lastActivity`; reverse index methods are available. User story phases can begin.

---

## Phase 3: User Story 1 — Schedule Into a Stable Account (Priority: P1) 🎯 MVP

**Goal**: New API-key requests are dispatched to stable accounts from the shared pool; stable accounts at capacity are silently skipped; available-slot detection works correctly.

**Independent Test**: Create a stable account with `maxStableSessions=1`. Send request A with session hash H1 → observe it lands on the stable account and a session mapping is created. Immediately send request B with session hash H2 → observe it is routed to a different account (stable account at capacity).

### Implementation for User Story 1

- [X] T011 [US1] In `src/services/unifiedClaudeScheduler.js`, in the Claude official shared pool loop inside `_getAllAvailableAccounts()` (around line 595), change the filter from `account.accountType === 'shared' || !account.accountType` to also include `account.accountType === 'stable'`, so stable accounts enter the candidate list.
- [X] T012 [US1] In `src/services/unifiedClaudeScheduler.js`, immediately after including a stable account in the Claude official shared pool candidate list (T011), add slot-capacity check: read `parseInt(account.maxStableSessions) || 1` and `parseInt(account.stableInactivityMinutes) ?? 5`; call `await this._countActiveStableSessionSlots(account.accountId, stableInactivityMinutes)`; if `activeSlots >= maxStableSessions`, skip this account with a `logger.debug` message: `"stable account {id} at capacity {active}/{max}"`.
- [X] T013 [US1] Apply the same two changes (T011–T012) to the Claude Console shared pool loop inside `_getAllAvailableAccounts()` (around line 667): include `account.accountType === 'stable'` in the filter and add the identical slot-capacity check after inclusion.
- [X] T014 [US1] In `src/services/unifiedClaudeScheduler.js`, in the session mapping creation path (around lines 372–376, after account selected and `sessionHash` is present): after the existing `_setSessionMapping(...)` call, add a conditional: `if (selectedAccount.accountType === 'stable' && sessionHash) { await this._addToStableAccountSessions(selectedAccount.accountId, sessionHash); }`. Apply the same pattern in the group scheduling session mapping creation path (around line 1710).
- [X] T015 [US1] Run `npx prettier --write src/services/unifiedClaudeScheduler.js` and verify `npm run lint` after US1 changes.

**Checkpoint**: Stable accounts appear in the shared pool; new sessions claim slots; at-capacity stable accounts are skipped silently. US1 is independently testable.

---

## Phase 4: User Story 2 — Continue an Existing Stable Session (Priority: P1)

**Goal**: Follow-up requests on an existing session continue routing to the same stable account; `lastActivity` is refreshed on each request; the per-session lazy cleanup path is wired.

**Independent Test**: Establish a session on stable account S (session hash H1). Wait 6+ minutes (or mock the timestamp to exceed `stableInactivityMinutes`). Send a follow-up with H1 → verify it still routes to S (not a different account) and the mapping's `lastActivity` is updated. Then send a second new session H2 → verify it now also lands on S (slot is considered available again).

### Implementation for User Story 2

- [X] T016 [US2] In `src/services/unifiedClaudeScheduler.js`, add private method `_updateSessionActivity(sessionHash, mapping)` that re-writes the session mapping JSON with `lastActivity: Date.now()` while resetting the TTL (same `setex` call as `_setSessionMapping` but reusing `mapping.accountId` and `mapping.accountType`). Place alongside the other session mapping methods.
- [X] T017 [US2] In `src/services/unifiedClaudeScheduler.js`, in the sticky-session reuse path (around line 306 where `_extendSessionMappingTTL` is called): replace the `_extendSessionMappingTTL` call with `await this._updateSessionActivity(sessionHash, mappingData)` so that `lastActivity` is refreshed along with the TTL. If `_extendSessionMappingTTL` is also called in group scheduling (line 1472) and CCR scheduling (line 1749), update those call sites too.
- [X] T018 [US2] In `src/services/unifiedClaudeScheduler.js`, in the sticky-session unavailability path (around lines 299–310, where the session mapping is deleted because the mapped account is no longer available): after the existing mapping deletion, add: `if (mapping.accountType starts with 'claude' or 'bedrock' or 'ccr' — i.e., always for stable) { await this._removeFromStableAccountSessions(mapping.accountId, sessionHash); }`. Guard with a check: only run if the unmapped account was a stable account (read from the mapping object: check that the account has `accountType === 'stable'` in its stored data, or check a `wasStable` flag). Simpler approach: always call `_removeFromStableAccountSessions` (SREM on a non-existent key is a no-op in Redis).
- [X] T019 [US2] Run `npx prettier --write src/services/unifiedClaudeScheduler.js` and verify `npm run lint` after US2 changes.

**Checkpoint**: Existing sessions continue to their stable account; `lastActivity` is refreshed; per-session cleanup on unavailability is wired. US2 is independently testable.

---

## Phase 5: User Story 3 — Configure Stable Account Parameters (Priority: P2)

**Goal**: Administrators can create and update stable accounts with `maxStableSessions` and `stableInactivityMinutes` through the admin API and management dashboard.

**Independent Test**: Use the admin API to `POST /admin/claude-accounts` with `accountType: 'stable', maxStableSessions: 2, stableInactivityMinutes: 3`. Verify the account is created, fields are persisted in Redis, and the scheduler respects the values on the next scheduling decision.

### Implementation for User Story 3

- [X] T020 [P] [US3] In `src/routes/admin.js`, Claude official account `POST /admin/claude-accounts` validation block (around line 3076): add `'stable'` to the valid `accountType` array `['shared', 'dedicated', 'group', 'stable']`. Add validation for `maxStableSessions` (optional integer ≥ 1, default 1) and `stableInactivityMinutes` (optional integer ≥ 0, default 5) mirroring the existing `maxConcurrentTasks` validation pattern. Apply the same changes to the `PUT /admin/claude-accounts/:id` update endpoint.
- [X] T021 [P] [US3] In `src/routes/admin.js`, Claude Console account `POST /admin/claude-console-accounts` validation block (around line 3637): same changes as T020 — add `'stable'` to valid accountType values and validate `maxStableSessions` and `stableInactivityMinutes`. Apply to `PUT /admin/claude-console-accounts/:id` as well.
- [X] T022 [P] [US3] In `src/services/claudeAccountService.js`, `createAccount()` method (lines 111–147): accept `maxStableSessions` and `stableInactivityMinutes` from the input parameter object. Store them in the Redis hash as strings: `maxStableSessions: String(maxStableSessions ?? 1)`, `stableInactivityMinutes: String(stableInactivityMinutes ?? 5)`. In `updateAccount()`, accept and persist the same fields. In the account retrieval function, parse them back as integers (matching `maxConcurrentTasks` pattern).
- [X] T023 [P] [US3] In `src/services/claudeConsoleAccountService.js`: apply identical changes to `createAccount()`, `updateAccount()`, and the retrieval function as described in T022.
- [X] T024 [US3] In `web/admin-spa/src/components/accounts/AccountForm.vue`, Claude official account section: add `{ value: 'stable', label: '稳定账户 (Stable)' }` to the `accountType` options list alongside existing `shared`/`dedicated`/`group` options. Place this in both create and edit mode accountType selectors.
- [X] T025 [US3] In `web/admin-spa/src/components/accounts/AccountForm.vue`, add two conditional form fields visible only when `form.accountType === 'stable'` for the Claude official section: a numeric input for `maxStableSessions` (label: "最大会话数", min=1, default=1) and a numeric input for `stableInactivityMinutes` (label: "不活跃超时(分钟)", min=0, default=5). Apply Tailwind dark mode classes (`dark:` prefix) consistent with adjacent fields.
- [X] T026 [US3] In `web/admin-spa/src/components/accounts/AccountForm.vue`, Claude Console section: apply the same changes as T024–T025 for the Console accountType selector and conditional stable fields.
- [X] T027 [US3] In `web/admin-spa/src/components/accounts/AccountForm.vue`, in the form data initialization object (around line 3921): add `maxStableSessions: props.account?.maxStableSessions || 1` and `stableInactivityMinutes: props.account?.stableInactivityMinutes ?? 5`. In `buildClaudeAccountData()` (around line 4531) and the Console equivalent: include `maxStableSessions` and `stableInactivityMinutes` in the payload when `accountType === 'stable'`.
- [X] T028 [US3] Run `npx prettier --write src/routes/admin.js src/services/claudeAccountService.js src/services/claudeConsoleAccountService.js web/admin-spa/src/components/accounts/AccountForm.vue` and verify `npm run lint` passes.

**Checkpoint**: Admin can configure stable accounts via API and dashboard. US3 is independently testable.

---

## Phase 6: User Story 4 — Stable Account Failure Per-Session Lazy Cleanup (Priority: P2)

**Goal**: Verify the cleanup path from US2 (T018) is correct for the multi-session scenario described in US4; add any missing logging.

**Independent Test**: Map sessions H1 (API key K1) and H2 (API key K2) to stable account S. Make S temporarily unavailable. Send a request with H1 → verify H1 is rescheduled, its mapping deleted, and removed from `stable_account_sessions:S`. Verify H2's mapping is still present in Redis. Send H2 → verify H2 is rescheduled and its mapping cleaned up.

### Implementation for User Story 4

- [X] T029 [US4] In `src/services/unifiedClaudeScheduler.js`, verify the cleanup code added in T018 correctly handles the multi-session scenario: confirm that `SREM stable_account_sessions:{accountId} {sessionHash}` removes only the specific session hash, not all members. Add a `logger.debug` line: `"stable account {id} session {sessionHash} cleaned up due to unavailability; other sessions unaffected"`.
- [X] T030 [US4] In `src/services/unifiedClaudeScheduler.js`, verify that the group scheduling unavailability path (around line 1488–1491, where mappings to unavailable group accounts are deleted) also calls `_removeFromStableAccountSessions` for stable accounts in the group. Add if missing.
- [X] T031 [US4] Run `npx prettier --write src/services/unifiedClaudeScheduler.js` and `npm run lint` after US4 changes.

**Checkpoint**: Per-session lazy cleanup is verified to work correctly across multi-session scenarios. US4 is independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final format, lint, and manual verification pass across all touched files.

- [X] T032 [P] Run `npx prettier --check src/services/unifiedClaudeScheduler.js src/routes/admin.js src/services/claudeAccountService.js src/services/claudeConsoleAccountService.js` — fix any remaining format issues.
- [X] T033 [P] Run `npx prettier --check web/admin-spa/src/components/accounts/AccountForm.vue` — fix any remaining format issues.
- [X] T034 Run `npm run lint` — confirm zero errors across all modified files.
- [ ] T035 Manual verification: create a stable account via admin dashboard with `maxStableSessions=1`, `stableInactivityMinutes=1`; confirm it appears in account list; confirm fields are saved correctly in Redis via `ssh cc2 "redis-cli HGETALL claude:account:{id}"`.
- [ ] T036 Manual verification: run `npm run cli status` to confirm service health after all changes; check `logs/claude-relay-*.log` for stable capacity log lines at debug level.
- [X] T037 Update `specs/001-stable-account-type/checklists/requirements.md` to mark any implementation-phase checklist items that are now verifiable.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately; all T001–T005 can run in parallel.
- **Phase 2 (Foundational)**: Depends on Phase 1 reading tasks. T006–T009 are sequential (each method builds on the previous). **BLOCKS all user story phases.**
- **Phase 3 (US1)**: Depends on Phase 2 completion. T011 → T012 sequential; T013 → T014 sequential; T011 and T013 can start in parallel (different loops in same file — coordinate to avoid conflicts).
- **Phase 4 (US2)**: Depends on Phase 2 completion. T016 → T017 → T018 are sequential (same file; T17 calls T016's method).
- **Phase 5 (US3)**: Depends on Phase 2 completion only. T020, T021, T022, T023 can run in parallel (different files). T024 → T025 → T026 → T027 sequential (same file, AccountForm.vue).
- **Phase 6 (US4)**: Depends on Phase 4 (US2) — T018 must exist before T029 can verify it.
- **Phase 7 (Polish)**: Depends on all story phases complete.

### User Story Dependencies

- **US1 (P1)**: After Phase 2 only. No dependency on US2/US3/US4.
- **US2 (P1)**: After Phase 2 only. No dependency on US1/US3/US4. (Works with or without US1; US1 and US2 both modify `unifiedClaudeScheduler.js` — serialize within the file or merge carefully.)
- **US3 (P2)**: After Phase 2 only. Independent of US1/US2 (different files except `unifiedClaudeScheduler.js` is not touched in US3).
- **US4 (P2)**: After US2 (T018 must exist). Verification and logging additions only.

### Within Each User Story

- Scheduler changes before admin/service changes (scheduler is the source of truth for behavior).
- Backend changes (admin.js, account services) before frontend (AccountForm.vue).
- Prettier + lint after each phase to keep diffs clean.

---

## Parallel Execution Example: US1 + US3

US1 (scheduler) and US3 (admin API + frontend) touch different primary files and can proceed concurrently after Phase 2:

```
Agent A (US1): T011 → T012 → T013 → T014 → T015
Agent B (US3): T020 ─┐
               T021   ├─ [parallel] → T024 → T025 → T026 → T027 → T028
               T022 ─┤
               T023 ─┘
```

---

## Implementation Strategy

### MVP First (US1 — Scheduler Core)

1. Complete Phase 1: Read and understand existing code.
2. Complete Phase 2: Add `lastActivity` + reverse index methods.
3. Complete Phase 3 (US1): Add stable accounts to shared pool with slot-capacity check.
4. **STOP and VALIDATE**: Create a stable account manually in Redis; run a request; confirm slot counting works.
5. Deploy if sufficient.

### Incremental Delivery

1. Phase 1 + 2 → Foundation ready.
2. Phase 3 (US1) → Stable accounts selectable from shared pool (MVP).
3. Phase 4 (US2) → Session continuity + `lastActivity` refresh.
4. Phase 5 (US3) → Admin API + dashboard configuration.
5. Phase 6 (US4) → Multi-session cleanup verified.
6. Phase 7 → Polish and final verification.

---

## Notes

- All five files to modify: `unifiedClaudeScheduler.js`, `admin.js`, `claudeAccountService.js`, `claudeConsoleAccountService.js`, `AccountForm.vue`.
- No new service files, route files, or Redis model files required.
- `SREM` on a non-existent key is safe (no-op) — the `_removeFromStableAccountSessions` call can always be made when cleaning up a session mapping without checking if the account was stable.
- The `_countActiveStableSessionSlots` method uses `SMEMBERS` + `MGET` (two Redis round-trips); for `maxStableSessions ≤ 10` this is negligible overhead. Acceptable for the current scale.
- Prettier must be applied after every file change before committing.
