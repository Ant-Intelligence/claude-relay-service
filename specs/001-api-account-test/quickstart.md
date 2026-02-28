# Quickstart: Gemini API & OpenAI Responses Account Testing

## Overview

Add manual connectivity testing for two account types that currently lack it: Gemini API (`gemini-api`) and OpenAI Responses (`openai-responses`). Follow the existing test patterns from Gemini OAuth and Claude Console accounts.

## Files to Modify

### Backend (4 changes)

1. **`src/services/geminiApiAccountService.js`** — Add `testAccount(accountId, model)` method
   - Fetch account, use `baseUrl` + `apiKey` to call Gemini generateContent
   - Return `{ success, responseText, usage, duration, error }`

2. **`src/services/openaiResponsesAccountService.js`** — Add `testAccount(accountId, model)` method
   - Fetch account, use `baseApi` + `apiKey` (Bearer) to call chat completions
   - Include `userAgent` header if configured
   - Return same result format

3. **`src/routes/admin.js`** — Add two SSE test endpoints
   - `POST /admin/gemini-api-accounts/:accountId/test`
   - `POST /admin/openai-responses-accounts/:accountId/test`
   - Both follow the existing SSE pattern from the Gemini OAuth test endpoint

### Frontend (2 changes)

4. **`web/admin-spa/src/components/accounts/AccountTestModal.vue`** — Extend for new platforms
   - `commonTestModels`: Add gemini-api and openai-responses model lists
   - `getTestEndpoint()`: Add endpoint URLs
   - `platformLabel`, `platformIcon`, `platformBadgeClass`: Add display metadata
   - `watch(props.show)`: Add default model selection

5. **`web/admin-spa/src/views/AccountsView.vue`** — Enable test button
   - `canTestAccount()`: Add `gemini-api` and `openai-responses` to whitelist

## Reference Implementations

- **Gemini OAuth test**: `geminiAccountService.js:testAccount()` (line ~1674)
- **SSE route pattern**: `admin.js` search for `gemini-accounts/:accountId/test`
- **Frontend modal**: `AccountTestModal.vue` — the `gemini` platform case

## Test Models

**Gemini API**: gemini-2.5-flash (default), gemini-2.5-pro, gemini-3-flash-preview, gemini-3-pro-preview, gemini-3.1-pro-preview

**OpenAI Responses**: gpt-5.1-codex-mini (default), gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.2

## Verification

1. Open admin panel → Accounts page
2. Find a Gemini API account → click Test button → select model → verify streaming response
3. Find an OpenAI Responses account → click Test button → select model → verify streaming response
4. Test with invalid API key → verify error message
5. Verify dark mode styling
