<!--
Sync Impact Report
===================
Version change: N/A (template) → 1.0.0 (initial adoption)
Modified principles: N/A (all new)
Added sections:
  - 7 Core Principles (Security First, Service Modularity,
    Backward Compatibility, Observability, Spec-Driven Development,
    Simplicity & Minimal Change, Resilience & Fault Tolerance)
  - Technology & Architecture Constraints
  - Development Workflow & Quality Gates
  - Governance
Removed sections: None
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ compatible (Constitution Check
    section already present, gates align with new principles)
  - .specify/templates/spec-template.md ✅ compatible (user story format
    and requirements align with Spec-Driven Development principle)
  - .specify/templates/tasks-template.md ✅ compatible (phase structure
    and parallel execution align with Simplicity principle)
  - .specify/templates/checklist-template.md ✅ compatible (generic
    format, no principle-specific content)
  - .specify/templates/agent-file-template.md ✅ compatible (technology
    extraction aligns with constraints section)
Follow-up TODOs: None
-->

# Claude Relay Service Constitution

## Core Principles

### I. Security First

All sensitive data (OAuth tokens, refresh tokens, API credentials)
MUST be encrypted with AES before storage in Redis. API Keys MUST
be stored as SHA-256 hashes, never in plaintext. Every request MUST
pass through the full authentication chain
(API Key verification → permission check → client validation →
model blacklist check) before reaching any relay service. No
shortcut or bypass is permitted regardless of internal origin.

**Rationale**: As a multi-tenant API relay handling third-party
credentials and billing, a single data leak compromises all
downstream accounts. Zero-trust verification ensures defense in
depth.

### II. Service Modularity

Each supported AI platform (Claude, Gemini, OpenAI, Bedrock, Azure,
Droid, CCR) MUST have its own dedicated relay service, account
service, and (where applicable) unified scheduler. Cross-platform
logic MUST be factored into shared utilities (`src/utils/`) rather
than duplicated across services. New platform integrations MUST
follow the existing service triplet pattern
(relay + account + scheduler).

**Rationale**: The relay service supports 8+ account types. Isolated
services prevent a bug in one platform from cascading to others and
allow independent evolution of each integration.

### III. Backward Compatibility

Feature additions and modifications MUST NOT alter existing API
behavior for current consumers. Existing endpoint contracts
(`/api/v1/messages`, `/gemini/v1/models/:model:generateContent`,
`/openai/v1/chat/completions`, etc.) MUST remain stable. When
extending data structures (Redis keys, pricing models, usage stats),
the system MUST gracefully handle records that lack new fields by
falling back to previous behavior.

**Rationale**: Production clients (Claude Code, Gemini CLI, Codex,
Cherry Studio) depend on stable API contracts. Breaking changes
disrupt all downstream users simultaneously.

### IV. Observability

All services MUST use Winston structured logging with appropriate
log levels. Every relay request MUST capture real usage data
(input/output/cache tokens) from upstream responses. Health
(`/health`) and metrics (`/metrics`) endpoints MUST report component
status, version, memory, and usage statistics. Cost calculation
MUST be recorded per request for billing accuracy. Cache hit rates
MUST be monitored via the global cache monitor.

**Rationale**: As a relay service, operators cannot debug issues by
inspecting upstream APIs directly. Comprehensive observability is
the only way to diagnose routing, billing, and performance problems.

### V. Spec-Driven Development

Non-trivial features MUST follow the speckit workflow:
**specify → plan → tasks → implement**. Each feature MUST have a
dedicated spec directory under `specs/[###-feature-name]/`
containing at minimum `spec.md` and `plan.md`. User stories MUST
be prioritized (P1, P2, P3) and independently testable. The plan
MUST include a Constitution Check gate that validates compliance
with these principles before implementation begins.

**Rationale**: The relay service has 30+ service files and complex
cross-cutting concerns. Spec-driven development prevents scope
creep, ensures architectural alignment, and creates an audit trail
for design decisions.

### VI. Simplicity & Minimal Change

Implementations MUST make the minimum changes necessary to fulfill
requirements. New abstractions MUST NOT be introduced for one-time
operations. Error handling and validation MUST only be added at
system boundaries (user input, external APIs), not for internal
code paths with framework guarantees. Feature flags and backward
compatibility shims MUST NOT be used when direct modification
suffices. Three similar lines of code are preferred over a premature
abstraction.

**Rationale**: With 30+ services and 13+ route files, unnecessary
complexity compounds rapidly. Each abstraction adds cognitive load
for all future contributors.

### VII. Resilience & Fault Tolerance

The system MUST handle upstream failures gracefully: 529 overload
errors MUST trigger automatic account exclusion for a configurable
duration. Token refresh MUST use a 10-second advance strategy to
prevent expiry during active requests. Client disconnections MUST
trigger resource cleanup via AbortController. Concurrent request
counts MUST auto-expire via Redis Sorted Set TTLs. Rate limit state
MUST be periodically cleaned by the rateLimitCleanupService. Redis
connection failures MUST trigger graceful degradation, not crash
the service.

**Rationale**: As middleware between clients and multiple AI APIs,
the relay service encounters transient failures frequently. Silent
failure and resource leaks directly impact all users.

## Technology & Architecture Constraints

- **Runtime**: Node.js 18+ with Express.js 4.x
- **Storage**: Redis via ioredis; all persistent state stored as
  Redis hashes with documented key patterns
  (`{type}_{subtype}:{id}`)
- **HTTP Client**: axios with configurable proxy support per account
- **Logging**: Winston with file rotation; logs categorized by
  subsystem under `logs/`
- **Frontend**: Vue 3 SPA (`web/admin-spa/`) with Tailwind CSS;
  MUST support dark mode (`dark:` prefix) and responsive design
  (`sm:`, `md:`, `lg:`, `xl:` breakpoints)
- **Code Format**: Prettier MUST be applied to all modified files
  before commit; ESLint MUST pass with zero errors
- **Encryption**: AES for data at rest; SHA-256 for API Key hashing
- **Streaming**: SSE with `X-Accel-Buffering: no` and
  `socket.setNoDelay(true)` for real-time responses
- **Deployment**: Docker Compose as primary deployment; support
  daemon mode via PM2

## Development Workflow & Quality Gates

### Pre-Implementation Gates

1. **Spec Review**: For non-trivial features, `spec.md` MUST exist
   and contain prioritized user stories with acceptance scenarios
2. **Plan Review**: `plan.md` MUST pass the Constitution Check
   table before implementation begins
3. **Task Breakdown**: `tasks.md` MUST organize work by user story
   phase with clear dependency ordering

### Implementation Gates

1. **Existing Pattern Check**: Before modifying any service, the
   developer MUST read and understand the existing code patterns
   in that file
2. **Format Check**: `npx prettier --check <file>` MUST pass for
   all modified files
3. **Lint Check**: `npm run lint` MUST produce zero errors
4. **Encryption Audit**: Any new storage of credentials or tokens
   MUST use the existing AES encryption pattern from
   `claudeAccountService.js`

### Post-Implementation Gates

1. **Manual Verification**: Use CLI tools (`npm run cli status`)
   to verify service health after changes
2. **Log Review**: Check `logs/claude-relay-*.log` for unexpected
   errors after deployment
3. **Backward Compatibility Test**: Verify existing API endpoints
   return identical responses for identical inputs

## Governance

This constitution is the authoritative source of project-level
principles. When conflicts arise between this document and ad-hoc
decisions, this constitution takes precedence.

### Amendment Procedure

1. Propose changes via a spec or PR description explaining the
   rationale
2. Update this file with the new or modified principle
3. Increment the version per semantic versioning:
   - **MAJOR**: Principle removed or fundamentally redefined
   - **MINOR**: New principle added or existing one materially
     expanded
   - **PATCH**: Wording clarification or typo fix
4. Update `LAST_AMENDED_DATE` to the amendment date
5. Review all templates in `.specify/templates/` for alignment
   with the change

### Compliance Review

- Every `plan.md` Constitution Check MUST reference the current
  version of this document
- Feature implementations that violate a principle MUST document
  the violation and justification in the plan's Complexity Tracking
  table
- The CLAUDE.md file serves as runtime development guidance and
  MUST remain consistent with this constitution

**Version**: 1.0.0 | **Ratified**: 2026-02-16 | **Last Amended**: 2026-02-16
