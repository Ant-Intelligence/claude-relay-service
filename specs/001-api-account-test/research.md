# Research: Gemini API & OpenAI Responses Account Testing

## R1: Gemini API Account Test Request Pattern

**Decision**: Use `${account.baseUrl}/v1beta/models/${model}:generateContent?key=${account.apiKey}` endpoint with a minimal payload.

**Rationale**: This matches how real Gemini API Key requests are sent in `geminiHandlers.js` (line 1964). API Key is passed as URL query parameter, not as a Bearer token. No OAuth token refresh needed.

**Alternatives considered**:
- CloudCode PA endpoint (`cloudcode-pa.googleapis.com/v1internal:generateContent`) — rejected because that's for OAuth accounts, not API Key accounts.
- Using `v1` instead of `v1beta` — rejected because the relay service consistently uses `v1beta` for API Key accounts.

## R2: OpenAI Responses Account Test Request Pattern

**Decision**: Use `${account.baseApi}/v1/chat/completions` with Bearer token auth and standard OpenAI chat completions payload.

**Rationale**: The `openaiResponsesRelayService.js` forwards requests using `${fullAccount.baseApi}${req.path}`. The chat completions endpoint is the standard OpenAI API path. Authorization uses `Bearer ${apiKey}` header format.

**Alternatives considered**:
- Using `/v1/responses` format — rejected because the relay service uses chat completions format for these accounts.
- Streaming test — rejected for simplicity; the existing Gemini test uses non-streaming and wraps results in SSE at the route level.

## R3: Test Function Architecture Pattern

**Decision**: Use the "sync test" pattern (Pattern B) — service returns `{ success, responseText, usage, duration }` and the route handler wraps it in SSE events.

**Rationale**: This matches the Gemini OAuth test pattern in `geminiAccountService.js:testAccount()` and keeps the test function simple. The route handler in `admin.js` already has the SSE wrapping template used for all test endpoints.

**Alternatives considered**:
- Stream test pattern (Pattern A, used by Claude Console) — rejected because it's more complex and unnecessary for a simple connectivity check.

## R4: Frontend Integration Points

**Decision**: Extend `AccountTestModal.vue` with new platform cases, and update `canTestAccount()` in `AccountsView.vue`.

**Rationale**: The modal already supports multi-platform testing via computed properties. Only 6 insertion points needed:
1. `commonTestModels` — add gemini-api and openai-responses model lists
2. `getTestEndpoint()` — add endpoint URLs
3. `platformLabel` — add display names
4. `platformIcon` — add icons
5. `platformBadgeClass` — add styling
6. `watch(props.show)` — add default model selection

**Alternatives considered**:
- Creating separate test modals per platform — rejected per Constitution Principle VI (Simplicity).

## R5: Proxy Configuration for Tests

**Decision**: Both test functions must support proxy via `ProxyHelper.createProxyAgent(account.proxy)`, setting `httpsAgent` and `httpAgent` on axios config, with `proxy: false` to prevent axios default proxy behavior.

**Rationale**: Consistent with all existing test implementations. Gemini API accounts parse proxy from JSON string in `getAccount()`. OpenAI Responses accounts also parse proxy in `getAccount()`.

## R6: OpenAI Responses Model List

**Decision**: Use user-specified Codex models: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini, gpt-5.2.

**Rationale**: Confirmed by user during clarification phase. These are the current models available for Codex CLI accounts. Default is `gpt-5.1-codex-mini` (smallest/cheapest).

## R7: canTestAccount Gate in AccountsView

**Decision**: Add `gemini-api` and `openai-responses` to the `canTestAccount()` function whitelist.

**Rationale**: This is the single gating function that controls whether the "Test" button appears for an account. Located in `AccountsView.vue`.
