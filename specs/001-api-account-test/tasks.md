# Tasks: Gemini API & OpenAI Responses Account Connectivity Testing

**Input**: Design documents from `/specs/001-api-account-test/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Not requested — no test tasks included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: No new project setup needed — all changes extend existing files. This phase is empty.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Enable the test button to appear for Gemini API and OpenAI Responses accounts in the frontend.

**⚠️ CRITICAL**: The test button must be visible before any test functionality can be manually verified.

- [x] T001 Add `'gemini-api'` and `'openai-responses'` to the `canTestAccount()` platform whitelist in `web/admin-spa/src/views/AccountsView.vue`

**Checkpoint**: Test buttons now appear on Gemini API and OpenAI Responses account cards (clicking them will show an error since backend isn't ready yet).

---

## Phase 3: User Story 1 - Test Gemini API Account Connectivity (Priority: P1) 🎯 MVP

**Goal**: Administrators can test Gemini API accounts by selecting a model and receiving a streaming test response.

**Independent Test**: Open admin panel → find a Gemini API account → click Test → select gemini-2.5-flash → verify streaming response with success status and duration.

### Implementation for User Story 1

- [x] T002 [P] [US1] Implement `testAccount(accountId, model)` method in `src/services/geminiApiAccountService.js` — fetch account via `getAccount()`, build URL `${account.baseUrl}/v1beta/models/${model}:generateContent?key=${account.apiKey}`, send minimal payload `{ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 100 } }`, support proxy via `ProxyHelper.createProxyAgent(account.proxy)`, return `{ success, responseText, usage: { promptTokenCount, candidatesTokenCount }, duration, error }`. Default model: `gemini-2.5-flash`. Default baseUrl: `https://generativelanguage.googleapis.com`. Timeout: 30s. Reference: existing `geminiAccountService.js:testAccount()` pattern and research.md R1.
- [x] T003 [P] [US1] Add SSE test endpoint `POST /admin/gemini-api-accounts/:accountId/test` in `src/routes/admin.js` — add after existing gemini-api-accounts routes (near line 5500). Accept `{ model }` from body, call `geminiApiAccountService.testAccount(accountId, model)`, wrap result in SSE events (`test_start`, `content`, `message_stop`, `test_complete`, `error`). Follow exact pattern from existing `POST /gemini-accounts/:accountId/test` route. Require `authenticateAdmin` middleware.
- [x] T004 [US1] Add `gemini-api` platform support to `AccountTestModal.vue` in `web/admin-spa/src/components/accounts/AccountTestModal.vue` — update 6 computed properties: (1) `commonTestModels`: add gemini-api case returning `[{ value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }, { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }, { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' }, { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' }, { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' }]`; (2) `getTestEndpoint()`: add `gemini-api` → `/admin/gemini-api-accounts/${id}/test`; (3) `platformLabel`: add `'Gemini API'`; (4) `platformIcon`: add `'fas fa-key'`; (5) `platformBadgeClass`: add `'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'`; (6) `watch(props.show)` default model: set `testModel.value = 'gemini-2.5-flash'` for gemini-api.

**Checkpoint**: Gemini API account testing fully functional — select model, click Test, see streaming response, verify success/error handling.

---

## Phase 4: User Story 2 - Test OpenAI Responses Account Connectivity (Priority: P1)

**Goal**: Administrators can test OpenAI Responses (Codex) accounts by selecting a model and receiving a streaming test response.

**Independent Test**: Open admin panel → find an OpenAI Responses account → click Test → select gpt-5.1-codex-mini → verify streaming response with success status and duration.

### Implementation for User Story 2

- [x] T005 [P] [US2] Implement `testAccount(accountId, model)` method in `src/services/openaiResponsesAccountService.js` — fetch account via `getAccount()`, build URL `${account.baseApi}/v1/chat/completions`, set headers `{ Authorization: 'Bearer ${apiKey}', 'Content-Type': 'application/json' }`, add `User-Agent: ${account.userAgent}` if configured, send payload `{ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }`, support proxy via `ProxyHelper.createProxyAgent(account.proxy)`, return `{ success, responseText, usage: { prompt_tokens, completion_tokens }, duration, error }`. Default model: `gpt-5.1-codex-mini`. Timeout: 30s. Reference: research.md R2.
- [x] T006 [P] [US2] Add SSE test endpoint `POST /admin/openai-responses-accounts/:accountId/test` in `src/routes/admin.js` — add after existing openai-responses-accounts routes. Accept `{ model }` from body, call `openaiResponsesAccountService.testAccount(accountId, model)`, wrap result in SSE events. Follow same pattern as T003. Require `authenticateAdmin` middleware.
- [x] T007 [US2] Add `openai-responses` platform support to `AccountTestModal.vue` in `web/admin-spa/src/components/accounts/AccountTestModal.vue` — update same 6 computed properties: (1) `commonTestModels`: add openai-responses case returning `[{ value: 'gpt-5.1-codex-mini', label: 'GPT 5.1 Codex Mini' }, { value: 'gpt-5.3-codex', label: 'GPT 5.3 Codex' }, { value: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' }, { value: 'gpt-5.1-codex-max', label: 'GPT 5.1 Codex Max' }, { value: 'gpt-5.2', label: 'GPT 5.2' }]`; (2) `getTestEndpoint()`: add `openai-responses` → `/admin/openai-responses-accounts/${id}/test`; (3) `platformLabel`: add `'OpenAI Responses'`; (4) `platformIcon`: add `'fas fa-key'`; (5) `platformBadgeClass`: add `'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'`; (6) `watch(props.show)` default model: set `testModel.value = 'gpt-5.1-codex-mini'` for openai-responses.

**Checkpoint**: OpenAI Responses account testing fully functional — select Codex model, click Test, see streaming response with token usage.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Code quality and formatting

- [x] T008 Run `npx prettier --write` on all modified files: `src/services/geminiApiAccountService.js`, `src/services/openaiResponsesAccountService.js`, `src/routes/admin.js`, `web/admin-spa/src/components/accounts/AccountTestModal.vue`, `web/admin-spa/src/views/AccountsView.vue`
- [x] T009 Run quickstart.md verification: test both account types in admin panel, verify dark mode styling, verify error messages for invalid API keys

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies — can start immediately
- **User Story 1 (Phase 3)**: Depends on T001 (canTestAccount whitelist)
- **User Story 2 (Phase 4)**: Depends on T001 (canTestAccount whitelist). Independent of User Story 1.
- **Polish (Phase 5)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after T001. No dependencies on other stories.
- **User Story 2 (P1)**: Can start after T001. No dependencies on other stories. Can run in parallel with US1.

### Within Each User Story

- Backend service method (T002/T005) and route (T003/T006) can be implemented in parallel [P]
- Frontend modal update (T004/T007) depends on backend being ready for end-to-end testing, but can be coded in parallel

### Parallel Opportunities

```
After T001:
  ┌─ US1: T002 [P] + T003 [P] → T004
  └─ US2: T005 [P] + T006 [P] → T007
Then: T008 → T009
```

---

## Parallel Example: User Story 1

```bash
# Launch backend tasks in parallel (different files):
Task: "T002 [P] [US1] Implement testAccount() in src/services/geminiApiAccountService.js"
Task: "T003 [P] [US1] Add SSE test endpoint in src/routes/admin.js"

# Then frontend (depends on backend for testing):
Task: "T004 [US1] Add gemini-api support to AccountTestModal.vue"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete T001: Enable test buttons (Foundational)
2. Complete T002 + T003 + T004: Gemini API testing
3. **STOP and VALIDATE**: Test Gemini API account in admin panel
4. Deploy/demo if ready

### Incremental Delivery

1. T001 → Test buttons visible
2. T002-T004 → Gemini API testing works → Validate
3. T005-T007 → OpenAI Responses testing works → Validate
4. T008-T009 → Code quality + full verification

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1 and US2 are both P1 priority but can be implemented sequentially or in parallel
- Commit after each task or logical group
- No new files created — all changes extend existing files
- Total: 9 tasks across 5 files
