# Implementation Plan: Gemini API & OpenAI Responses Account Connectivity Testing

**Branch**: `001-api-account-test` | **Date**: 2026-02-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-api-account-test/spec.md`

## Summary

Add manual connectivity testing for Gemini API (API Key auth) and OpenAI Responses (Codex) accounts, following the existing test patterns from Gemini OAuth accounts. Each account type gets a `testAccount()` service method, an SSE test endpoint in admin routes, and frontend support in the shared test modal with platform-appropriate model selectors.

## Technical Context

**Language/Version**: Node.js 18+ (Express.js 4.18.2)
**Primary Dependencies**: axios (HTTP), ioredis (Redis), winston (logging), ProxyHelper (proxy agents)
**Storage**: Redis (existing accounts, no new keys)
**Testing**: Manual verification via admin panel
**Target Platform**: Linux server (Docker) + Vue 3 SPA admin panel
**Project Type**: Web application (Node.js backend + Vue 3 frontend)
**Performance Goals**: Test response within 30 seconds
**Constraints**: Must follow existing SSE event protocol; must support account proxy configuration
**Scale/Scope**: 2 new test endpoints, 2 new service methods, frontend modal updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle                       | Status | Notes                                                                                             |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| I. Security First               | PASS   | No new credential storage. Existing encrypted API keys are decrypted via existing service methods. |
| II. Service Modularity          | PASS   | Each account type's test function lives in its own service file (geminiApiAccountService, openaiResponsesAccountService). |
| III. Backward Compatibility     | PASS   | No existing endpoints or behavior modified. Only new endpoints added.                             |
| IV. Observability               | PASS   | Test results logged via winston with success/error status and duration.                           |
| V. Spec-Driven Development      | PASS   | Following speckit workflow: specify → clarify → plan → tasks → implement.                        |
| VI. Simplicity & Minimal Change | PASS   | Extending existing modal component, not creating new ones. Using sync test pattern (simpler). 5 files changed total. |
| VII. Resilience & Fault Tolerance | PASS | 30-second timeout on test requests. Error messages propagated from upstream APIs.                 |

**Post-Phase 1 re-check**: PASS — No design changes that affect constitution compliance.

## Project Structure

### Documentation (this feature)

```text
specs/001-api-account-test/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── test-endpoints.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (files to modify)

```text
src/
├── services/
│   ├── geminiApiAccountService.js      # Add testAccount() method
│   └── openaiResponsesAccountService.js # Add testAccount() method
└── routes/
    └── admin.js                         # Add 2 SSE test endpoints

web/admin-spa/src/
├── components/accounts/
│   └── AccountTestModal.vue             # Extend for gemini-api, openai-responses
└── views/
    └── AccountsView.vue                 # Add to canTestAccount() whitelist
```

**Structure Decision**: Web application — backend services + routes in `src/`, frontend SPA in `web/admin-spa/src/`. All changes extend existing files; no new files created.

## Implementation Details

### Backend: geminiApiAccountService.testAccount()

- Fetch account via existing `getAccount(accountId)` (auto-decrypts API key)
- Build URL: `${account.baseUrl}/v1beta/models/${model}:generateContent?key=${account.apiKey}`
- Payload: `{ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 100 } }`
- Proxy: `ProxyHelper.createProxyAgent(account.proxy)`
- Return: `{ success, responseText, usage: { promptTokenCount, candidatesTokenCount }, duration, error }`
- Reference: See [research.md](./research.md) R1

### Backend: openaiResponsesAccountService.testAccount()

- Fetch account via existing `getAccount(accountId)` (auto-decrypts API key)
- Build URL: `${account.baseApi}/v1/chat/completions`
- Headers: `Authorization: Bearer ${apiKey}`, optional `User-Agent: ${account.userAgent}`
- Payload: `{ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }`
- Proxy: `ProxyHelper.createProxyAgent(account.proxy)`
- Return: `{ success, responseText, usage: { prompt_tokens, completion_tokens }, duration, error }`
- Reference: See [research.md](./research.md) R2

### Backend: admin.js Routes

Two new `POST` endpoints following the exact SSE pattern from the existing Gemini OAuth test route:
- `POST /admin/gemini-api-accounts/:accountId/test` → calls `geminiApiAccountService.testAccount()`
- `POST /admin/openai-responses-accounts/:accountId/test` → calls `openaiResponsesAccountService.testAccount()`
- Reference: See [contracts/test-endpoints.md](./contracts/test-endpoints.md)

### Frontend: AccountTestModal.vue

Six insertion points (see [research.md](./research.md) R4):

1. **`commonTestModels`** — gemini-api uses same list as gemini; openai-responses uses Codex models
2. **`getTestEndpoint()`** — map platform to admin endpoint URL
3. **`platformLabel`** — "Gemini API", "OpenAI Responses"
4. **`platformIcon`** — `fas fa-key` for both (API Key auth)
5. **`platformBadgeClass`** — blue for gemini-api, green for openai-responses
6. **`watch(props.show)` default model** — `gemini-2.5-flash` and `gpt-5.1-codex-mini`

### Frontend: AccountsView.vue

Add `'gemini-api'` and `'openai-responses'` to the `canTestAccount()` platform whitelist.
