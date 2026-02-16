# Feature Specification: Fix API Key Weekly Cost Limit (weeklyCostLimit)

**Feature Branch**: `001-fix-apikey-weekly-limit`
**Created**: 2026-02-16
**Status**: Draft
**Input**: User description: "创建api key时设置周限无效，api key列表页面不显示，编辑api key的表单中也没有对应的值，是空值，编辑api key保存生效的。请定位修复"

## Root Cause Analysis

The active route file is `src/routes/admin.js` (NOT `src/routes/admin/apiKeys.js`
which is unused/legacy). The `weeklyCostLimit` field is missing from the
CREATE endpoints:

1. **CREATE endpoint** (`POST /admin/api-keys` in `src/routes/admin.js:1112`):
   `weeklyCostLimit` is NOT destructured from `req.body` (lines 1114-1142)
   and NOT passed to `apiKeyService.generateApiKey()` (lines 1270-1298).
   As a result, the service receives `undefined` which defaults to `0`.

2. **BATCH CREATE endpoint** (`POST /admin/api-keys/batch` in `src/routes/admin.js:1309`):
   Same issue — `weeklyCostLimit` is NOT destructured (lines 1311-1340) and
   NOT passed to `apiKeyService.generateApiKey()` (lines 1371-1399).

3. **UPDATE endpoint** (`PUT /admin/api-keys/:keyId` in `src/routes/admin.js:1629`):
   This endpoint WORKS correctly — `weeklyCostLimit` IS destructured (line 1655)
   and IS validated/assigned to updates (lines 1832-1839). This matches the
   user's report that "editing and saving works."

The frontend (CreateApiKeyModal.vue, EditApiKeyModal.vue) correctly sends
`weeklyCostLimit` in the request payload. The backend service
(`apiKeyService.js:150`) correctly accepts and stores it. Only the CREATE
route handlers are missing the field.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create API Key with Weekly Cost Limit (Priority: P1)

As an administrator, I create a new API key and set a weekly cost limit
(e.g., $200). After creation, the weekly cost limit is persisted and
enforced immediately, without needing to edit the key again.

**Why this priority**: This is the primary reported bug. Administrators
expect cost limits set during creation to take effect immediately. The
current workaround (create then edit) is error-prone and may lead to
uncontrolled spending if the admin forgets the extra step.

**Independent Test**: Create an API key with weeklyCostLimit set to 200
via the admin UI or API. Retrieve the key and verify weeklyCostLimit
equals 200, not 0.

**Acceptance Scenarios**:

1. **Given** the admin is on the Create API Key form, **When** they enter
   a weekly cost limit of $500 and submit, **Then** the newly created
   API key's `weeklyCostLimit` field is stored as `500` in the backend.
2. **Given** the admin creates an API key with weeklyCostLimit = 200,
   **When** they view the API key list, **Then** the weekly cost limit
   and usage progress bar are displayed for that key.
3. **Given** the admin creates an API key without setting a weekly cost
   limit (field left blank), **When** the key is created, **Then**
   `weeklyCostLimit` defaults to `0` (no limit), matching current
   behavior for other cost limit fields.

---

### User Story 2 - Edit API Key Weekly Cost Limit (Priority: P1)

As an administrator, I edit an existing API key to add, change, or
remove the weekly cost limit. The updated value persists correctly.

**Why this priority**: The user reported that editing and saving works,
but investigation shows the UPDATE route also drops `weeklyCostLimit`.
If "saving works" was observed, it may only be for `weeklyOpusCostLimit`
(a different field). Both create and update routes must be fixed.

**Independent Test**: Edit an existing API key, set weeklyCostLimit to
300, save. Retrieve the key and verify weeklyCostLimit equals 300.

**Acceptance Scenarios**:

1. **Given** an existing API key with weeklyCostLimit = 0, **When** the
   admin edits it to set weeklyCostLimit = 300 and saves, **Then** the
   stored value is updated to `300`.
2. **Given** an existing API key with weeklyCostLimit = 500, **When**
   the admin opens the edit form, **Then** the weekly cost limit field
   shows `500` (not blank).
3. **Given** an existing API key with weeklyCostLimit = 500, **When**
   the admin clears the field and saves, **Then** weeklyCostLimit is
   reset to `0`.

---

### Edge Cases

- What happens when `weeklyCostLimit` is sent as a string (e.g., "200")?
  The system MUST parse it to a number, consistent with how
  `dailyCostLimit` and `weeklyOpusCostLimit` are handled.
- What happens when `weeklyCostLimit` is negative?
  The system MUST reject it with a 400 error.
- What happens when `weeklyCostLimit` is non-numeric (e.g., "abc")?
  The system MUST reject it with a 400 error.
- What happens when an API key created before this fix has no
  `weeklyCostLimit` stored? The system MUST default to `0` (no limit),
  which is already handled by `apiKeyService.js:238`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The CREATE API key endpoint MUST accept `weeklyCostLimit`
  from the request body and pass it to the API key service.
- **FR-002**: The BATCH CREATE API key endpoint MUST accept
  `weeklyCostLimit` from the request body and pass it to the API key
  service for each created key.
- **FR-003**: The existing frontend behavior (create modal, edit modal,
  list display) MUST continue to work without modification, since the
  frontend already sends and renders `weeklyCostLimit` correctly.
- **FR-004**: The UPDATE endpoint already works correctly and MUST NOT
  be modified.

### Assumptions

- The frontend CreateApiKeyModal.vue and EditApiKeyModal.vue already
  include `weeklyCostLimit` in their form data and API payloads. No
  frontend changes are needed.
- The ApiKeysView.vue already conditionally displays weekly cost limit
  progress bars when `weeklyCostLimit > 0`. No frontend changes are
  needed.
- The apiKeyService.generateApiKey() already accepts `weeklyCostLimit`
  as a parameter (line 150) and stores it (line 190). No service layer
  changes are needed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An API key created with weeklyCostLimit = 500 via the
  admin UI retains that value when retrieved — verified by checking the
  key detail in the list view or via the GET API.
- **SC-002**: An API key edited to change weeklyCostLimit from 0 to 300
  shows the updated value in both the edit form and the list view.
- **SC-003**: The weekly cost limit enforcement (blocking requests when
  weekly spending exceeds the limit) works for keys created via the
  create flow, not just the edit flow.
- **SC-004**: Invalid values for weeklyCostLimit (negative, non-numeric)
  are rejected with clear error messages during both create and update.
