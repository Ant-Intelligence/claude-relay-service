# Tasks: Fix API Key Weekly Cost Limit (weeklyCostLimit)

**Input**: Design documents from `/specs/001-fix-apikey-weekly-limit/`
**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: Not requested in the feature specification. No test tasks included.

**Organization**: Tasks are grouped by user story. US2 (edit) requires no
code changes (already works), so its phase is verification-only.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Verify environment and understand existing code patterns

- [x] T001 Read the existing CREATE endpoint in src/routes/admin.js (lines 1112-1306) to confirm the missing `weeklyCostLimit` field and identify exact insertion points
- [x] T002 Read the existing BATCH CREATE endpoint in src/routes/admin.js (lines 1309-1443) to confirm the same missing field and identify exact insertion points

**Checkpoint**: Insertion points confirmed, existing patterns understood

---

## Phase 2: User Story 1 - Create API Key with Weekly Cost Limit (Priority: P1) 🎯 MVP

**Goal**: `weeklyCostLimit` set during single or batch API key creation is persisted to Redis

**Independent Test**: Create an API key with weeklyCostLimit=200 via API, retrieve it, verify value is 200

### Implementation for User Story 1

- [x] T003 [US1] Add `weeklyCostLimit` to req.body destructuring in single CREATE endpoint at src/routes/admin.js (after `weeklyOpusCostLimit` at line 1136)
- [x] T004 [US1] Add `weeklyCostLimit` to `apiKeyService.generateApiKey()` call in single CREATE endpoint at src/routes/admin.js (after `weeklyOpusCostLimit` at line 1292)
- [x] T005 [US1] Add `weeklyCostLimit` to req.body destructuring in BATCH CREATE endpoint at src/routes/admin.js (after `weeklyOpusCostLimit` at line 1334)
- [x] T006 [US1] Add `weeklyCostLimit` to `apiKeyService.generateApiKey()` call in BATCH CREATE endpoint at src/routes/admin.js (after `weeklyOpusCostLimit` at line 1393)

**Checkpoint**: Single and batch API key creation now persists weeklyCostLimit

---

## Phase 3: User Story 2 - Edit API Key Weekly Cost Limit (Priority: P1)

**Goal**: Verify that the UPDATE endpoint already works correctly — no code changes needed

**Independent Test**: Edit an existing API key, set weeklyCostLimit to 300, save, verify value persists

### Verification for User Story 2

- [x] T007 [US2] Verify UPDATE endpoint in src/routes/admin.js already destructures `weeklyCostLimit` (line 1655) and validates/assigns it (lines 1832-1839) — confirm no changes needed

**Checkpoint**: Edit flow confirmed working, no regressions from US1 changes

---

## Phase 4: Polish & Verification

**Purpose**: Format check and end-to-end verification

- [x] T008 Run `npx prettier --write src/routes/admin.js` to ensure formatting compliance
- [x] T009 Run `npm run lint` to verify zero ESLint errors
- [ ] T010 End-to-end verification: create API key with weeklyCostLimit via admin UI, verify value persists in list view and edit form

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — read-only tasks
- **User Story 1 (Phase 2)**: Depends on Phase 1 for insertion point confirmation
- **User Story 2 (Phase 3)**: Independent of Phase 2 — verification only
- **Polish (Phase 4)**: Depends on Phase 2 completion

### Within User Story 1

- T003 and T005 are in the same file but different code locations — execute sequentially to avoid conflicts
- T003 → T004 (same endpoint, destructuring before service call)
- T005 → T006 (same endpoint, destructuring before service call)

### Parallel Opportunities

- T001 and T002 can run in parallel (read-only, different code sections)
- T007 can run in parallel with T003-T006 (verification of unmodified code)
- T008 and T009 can run in parallel after T006 completes

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Read and confirm insertion points
2. Complete Phase 2: Apply 4 line additions (T003-T006)
3. Run T008-T009: Format and lint check
4. **STOP and VALIDATE**: Create API key with weekly limit via UI
5. Deploy if ready

### Incremental Delivery

1. T003+T004 → Single create fixed → Verify via API
2. T005+T006 → Batch create fixed → Verify via API
3. T007 → Confirm edit still works → No regressions
4. T008-T010 → Polish and full verification

---

## Notes

- All changes are in a single file: `src/routes/admin.js`
- Total additions: 4 lines (2 per endpoint × 2 endpoints)
- No deletions, no refactoring, no frontend changes
- The UPDATE endpoint (line 1629) MUST NOT be modified
- Commit after T006 (all functional changes) then T008-T009 (formatting)
