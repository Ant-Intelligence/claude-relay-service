# API Contracts: Account Test Endpoints

## POST /admin/gemini-api-accounts/:accountId/test

**Auth**: Admin JWT (Bearer token)
**Content-Type**: application/json

### Request

```json
{
  "model": "gemini-2.5-flash"
}
```

### Response (SSE stream)

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**Success flow**:
```
data: {"type":"test_start"}

data: {"type":"content","text":"Hello! How can I help you?"}

data: {"type":"message_stop"}

data: {"type":"test_complete","success":true,"usage":{"promptTokenCount":1,"candidatesTokenCount":8},"duration":1234}

```

**Error flow**:
```
data: {"type":"test_start"}

data: {"type":"error","error":"API key not valid. Please pass a valid API key."}

```

---

## POST /admin/openai-responses-accounts/:accountId/test

**Auth**: Admin JWT (Bearer token)
**Content-Type**: application/json

### Request

```json
{
  "model": "gpt-5.1-codex-mini"
}
```

### Response (SSE stream)

Same SSE protocol as above.

**Success flow**:
```
data: {"type":"test_start"}

data: {"type":"content","text":"Hello! How can I assist you today?"}

data: {"type":"message_stop"}

data: {"type":"test_complete","success":true,"usage":{"prompt_tokens":8,"completion_tokens":9},"duration":987}

```

**Error flow**:
```
data: {"type":"test_start"}

data: {"type":"error","error":"Incorrect API key provided."}

```

---

## SSE Event Protocol (shared)

| Event Type      | Fields                                       | When                        |
| --------------- | -------------------------------------------- | --------------------------- |
| `test_start`    | —                                            | Immediately on request      |
| `content`       | `text: string`                               | Response text received      |
| `message_stop`  | —                                            | Response complete           |
| `test_complete` | `success: true, usage: object, duration: ms` | Test finished successfully  |
| `error`         | `error: string`                              | Test failed                 |
