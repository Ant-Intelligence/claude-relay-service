# Feature Specification: Gemini API & OpenAI Responses Account Connectivity Testing

**Feature Branch**: `001-api-account-test`
**Created**: 2026-02-28
**Status**: Draft
**Input**: User description: "gemini api 和 OpenAI-Responses 帐号都没有测试功能，需要能选择指定模型做测试，具体实现可以参考claude console帐号"

## Clarifications

### Session 2026-02-28

- Q: What should the complete model list be for the OpenAI Responses test selector? → A: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini, gpt-5.2

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Test Gemini API Account Connectivity (Priority: P1)

As an administrator, I want to manually test a Gemini API account by selecting a specific model and sending a test request, so that I can verify the account's API key, proxy settings, and model access are working correctly before routing real user traffic to it.

**Why this priority**: Gemini API accounts use API Key authentication and currently have no way to verify connectivity. This is the most frequently needed test capability since misconfigured API keys or proxy settings are common failure points.

**Independent Test**: Can be fully tested by opening a Gemini API account in the admin panel, clicking the test button, selecting a model, and observing a streaming response.

**Acceptance Scenarios**:

1. **Given** a configured Gemini API account with a valid API key, **When** the admin selects a model (e.g., gemini-2.5-flash) and clicks "Test", **Then** the system sends a test request and streams the response text back in real-time, showing success status and response duration.
2. **Given** a Gemini API account with an invalid or expired API key, **When** the admin runs a test, **Then** the system displays a clear error message indicating the authentication failure.
3. **Given** a Gemini API account configured with a proxy, **When** the admin runs a test, **Then** the test request is sent through the configured proxy.
4. **Given** the admin opens the test modal for a Gemini API account, **When** the model dropdown is displayed, **Then** it shows Gemini-specific models (e.g., gemini-2.5-flash, gemini-2.5-pro, gemini-3-flash-preview, gemini-3-pro-preview, gemini-3.1-pro-preview).

---

### User Story 2 - Test OpenAI Responses Account Connectivity (Priority: P1)

As an administrator, I want to manually test an OpenAI Responses account by selecting a specific model and sending a test request, so that I can verify the account's API key, base URL, proxy settings, and model access are working correctly.

**Why this priority**: OpenAI Responses accounts (used by Codex CLI) also have no testing capability. These accounts have unique configuration requirements (custom base URL, optional User-Agent) that need verification. Equal priority with Gemini API since both are critical gaps.

**Independent Test**: Can be fully tested by opening an OpenAI Responses account in the admin panel, clicking the test button, selecting a model, and observing a streaming response.

**Acceptance Scenarios**:

1. **Given** a configured OpenAI Responses account with a valid API key and base URL, **When** the admin selects a model (e.g., gpt-5.1-codex-mini) and clicks "Test", **Then** the system sends a test request and streams the response text back in real-time, showing success status and response duration.
2. **Given** an OpenAI Responses account with an invalid API key, **When** the admin runs a test, **Then** the system displays a clear error message indicating the authentication failure.
3. **Given** an OpenAI Responses account configured with a custom User-Agent, **When** the admin runs a test, **Then** the test request includes the configured User-Agent header.
4. **Given** an OpenAI Responses account configured with a proxy, **When** the admin runs a test, **Then** the test request is sent through the configured proxy.
5. **Given** the admin opens the test modal for an OpenAI Responses account, **When** the model dropdown is displayed, **Then** it shows OpenAI Codex models: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini, gpt-5.2.

---

### User Story 3 - Consistent Test Experience Across Account Types (Priority: P2)

As an administrator, I want the test experience for Gemini API and OpenAI Responses accounts to follow the same patterns as existing account tests (Claude Console, Bedrock, Gemini OAuth), so that I have a familiar, consistent interface regardless of account type.

**Why this priority**: Consistency reduces cognitive load and ensures the admin can efficiently manage all account types. This is a quality-of-life priority rather than a functional blocker.

**Independent Test**: Can be verified by comparing the test modal UI and behavior across all account types — they should share the same layout, status indicators, streaming display, and error presentation patterns.

**Acceptance Scenarios**:

1. **Given** any testable account type, **When** the admin opens the test modal, **Then** the modal displays the same layout: platform badge, model selector, test button, streaming response area, and status indicators.
2. **Given** the test is in progress for any account type, **When** response data streams in, **Then** the text appears incrementally in the response area with a duration timer.
3. **Given** the admin interface displays an account card for Gemini API or OpenAI Responses, **When** the test button is visible, **Then** it uses appropriate platform labels ("Gemini API", "OpenAI Responses") and styling consistent with the platform's visual theme.

---

### Edge Cases

- What happens when a Gemini API account has no baseUrl configured? The system should use the default Gemini API base URL (`https://generativelanguage.googleapis.com`).
- What happens when an OpenAI Responses account's base URL is unreachable? The system should display a connection timeout error within 30 seconds.
- What happens when the selected test model is not available on the account? The system should display the API error message returned by the provider.
- What happens when the proxy configured on the account is down? The system should display a proxy connection error.
- What happens when the account's subscription has expired (OpenAI Responses)? The system should still allow the test and display whatever error the API returns.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a test endpoint for Gemini API accounts that accepts an account ID and model name, sends a test request using the account's API key and proxy configuration, and returns results via SSE streaming.
- **FR-002**: System MUST provide a test endpoint for OpenAI Responses accounts that accepts an account ID and model name, sends a test request using the account's API key, base URL, User-Agent, and proxy configuration, and returns results via SSE streaming.
- **FR-003**: The SSE streaming response MUST follow the existing event protocol: `test_start`, `content`, `message_stop`, `test_complete` (with success, usage, duration), and `error` events.
- **FR-004**: The admin interface MUST display a model selector with platform-appropriate model options when testing Gemini API or OpenAI Responses accounts.
- **FR-005**: The admin interface MUST route test requests to the correct backend endpoint based on account platform type.
- **FR-006**: The test request for Gemini API accounts MUST use the account's `baseUrl` and `apiKey` to call the Gemini generateContent API with a minimal test payload.
- **FR-007**: The test request for OpenAI Responses accounts MUST use the account's `baseApi` and `apiKey` to call the chat completions API with a minimal test payload.
- **FR-008**: Both test functions MUST support the account's proxy configuration during the test request.
- **FR-009**: The admin interface MUST display appropriate platform labels and visual styling for Gemini API and OpenAI Responses accounts in the test modal.

### Key Entities

- **Gemini API Account**: API Key-authenticated Gemini account with baseUrl, apiKey, proxy, and supportedModels fields.
- **OpenAI Responses Account**: API Key-authenticated OpenAI account with baseApi, apiKey, userAgent, proxy fields.
- **Test Result**: Streaming result containing response text, usage metadata (token counts), duration, and success/error status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Administrators can test Gemini API account connectivity and receive a pass/fail result with response text within 30 seconds.
- **SC-002**: Administrators can test OpenAI Responses account connectivity and receive a pass/fail result with response text within 30 seconds.
- **SC-003**: 100% of the existing test UI patterns (model selector, streaming display, status indicators, error messages) are consistently applied to the new account types.
- **SC-004**: Test results correctly identify common failure modes: invalid API key, unreachable base URL, proxy failure, and model not available — each with a distinct, actionable error message.

## Assumptions

- The Gemini API test will use the standard `v1beta/models/{model}:generateContent` endpoint with API key authentication, matching how real requests are sent for Gemini API accounts.
- The OpenAI Responses test will use the standard `/v1/chat/completions` endpoint format, matching how real requests are sent for OpenAI Responses accounts.
- The test payload will be minimal (a simple "hi" message with low max_tokens) to minimize cost and latency.
- The default test model for Gemini API accounts will be `gemini-2.5-flash` (fast and cost-effective).
- The default test model for OpenAI Responses accounts will be `gpt-5.1-codex-mini` (smallest and most cost-effective Codex model).
- Test results do not need to be persisted or included in scheduled testing at this stage — manual testing only.

## Scope Boundaries

### In Scope

- Backend test endpoints for Gemini API and OpenAI Responses accounts
- Backend test functions in the respective account services
- Frontend model selector lists for both account types
- Frontend endpoint routing and platform label/styling updates

### Out of Scope

- Scheduled/automated testing for these account types (can be added later)
- Test history persistence for these account types
- Testing for other untested account types (droid, azure-openai, ccr)
