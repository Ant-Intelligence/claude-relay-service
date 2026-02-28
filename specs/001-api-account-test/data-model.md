# Data Model: Gemini API & OpenAI Responses Account Testing

No new data entities are introduced. This feature extends existing entities with new behavior (test functions).

## Existing Entities Used

### Gemini API Account

**Redis Key**: `gemini_api_account:{id}`
**Service**: `geminiApiAccountService.js`

| Field     | Type   | Usage in Test                              |
| --------- | ------ | ------------------------------------------ |
| id        | string | Account identifier                         |
| name      | string | Logging                                    |
| baseUrl   | string | API endpoint base (default: `https://generativelanguage.googleapis.com`) |
| apiKey    | string | Decrypted API key for `?key=` param        |
| proxy     | object | Proxy config for test request              |
| status    | string | Check if account is usable                 |
| isActive  | string | Check if account is enabled                |

### OpenAI Responses Account

**Redis Key**: `openai_responses_account:{id}`
**Service**: `openaiResponsesAccountService.js`

| Field     | Type   | Usage in Test                              |
| --------- | ------ | ------------------------------------------ |
| id        | string | Account identifier                         |
| name      | string | Logging                                    |
| baseApi   | string | API endpoint base (e.g., `https://api.openai.com`) |
| apiKey    | string | Decrypted API key for Bearer auth          |
| userAgent | string | Optional custom User-Agent header          |
| proxy     | object | Proxy config for test request              |
| status    | string | Check if account is usable                 |
| isActive  | string | Check if account is enabled                |

### Test Result (Transient — not persisted)

| Field        | Type    | Description                           |
| ------------ | ------- | ------------------------------------- |
| success      | boolean | Whether the test passed               |
| responseText | string  | Model's response text (on success)    |
| usage        | object  | Token counts (on success)             |
| duration     | number  | Elapsed time in milliseconds          |
| error        | string  | Error message (on failure)            |
