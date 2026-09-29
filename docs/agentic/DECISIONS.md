# Decisions

## Current Decision Index

| Area | Current decision | Current-truth owner | Supersedes |
| --- | --- | --- | --- |
| Workflow approval | DEC-0011 | root `AGENTS.md` / Workflow Policy | DEC-0001 |
| Phase continuity | DEC-0002 | root `AGENTS.md` / Phase Mode | none |
| Change strategy | DEC-0003 | `ARCHITECTURE.md` / Constraints | none |
| Learning truth | DEC-0004 | `PRODUCT.md` / Product Rules | none |
| Provenance boundary | DEC-0005 | `SECURITY.md` / Authorization | none |
| Runtime center | DEC-0006 | `ARCHITECTURE.md` / Interfaces | none |
| MCP protocol boundary | DEC-0007 | `ARCHITECTURE.md` / Adapters | none |
| Release claims | DEC-0008 | `PROJECT-BLUEPRINT.md` / Release Boundaries | none |
| OUT-001 execution selection | DEC-0009 | `ROADMAP.md` / OUT-001 Execution Binding | none |
| Bun runtime floor | DEC-0010 | `ARCHITECTURE.md` / Technology Stack | none |
| OUT-002 execution selection | DEC-0012 | `ROADMAP.md` / OUT-002 Execution Binding | none |
| OUT-002 persistence adapter | DEC-0013 | `ARCHITECTURE.md` / Technology Stack and Interfaces | none |

## Immutable Decision Ledger

### DEC-0001: Review-gated project documents

**Area:** Workflow approval
**Decision:** Exact Foundation, Design Spec, Implementation Plan, and consequential public-document change sets require readable user approval before progression.
**Rationale:** The user explicitly instructed “согласовывай все доки” on 2026-09-29.
**Alternatives:** Autonomous policy; approval only for external actions.
**Evidence:** User instruction in the current task, observed 2026-09-29.
**Current Truth:** root `AGENTS.md` / Workflow Policy
**Blueprint Requirements:** all
**Roadmap Outcomes:** OUT-001 through OUT-010
**Supersedes:** none

### DEC-0002: Same-session phase mode

**Area:** Phase continuity
**Decision:** Continue phases in the same exact checkout/session and reread changed inputs at each boundary.
**Rationale:** The user asked the current session to create tasks, execute them, and merge them; a fresh-session requirement was not requested or evidenced.
**Alternatives:** Automated fresh-session handoff.
**Evidence:** Current task instruction and exact checkout `/Users/mkiktev/Documents/agents_system/AugustAgents`.
**Current Truth:** root `AGENTS.md` / Phase Mode
**Blueprint Requirements:** all
**Roadmap Outcomes:** OUT-001 through OUT-010
**Supersedes:** none

### DEC-0003: Preserve and evolve the current codebase

**Area:** Change strategy
**Decision:** Use bounded incremental outcomes; do not rewrite the repository wholesale.
**Rationale:** The package boundaries and many security primitives are useful, while the audit identifies missing contracts rather than a useless foundation.
**Alternatives:** Greenfield rewrite; feature expansion over the current runtime.
**Evidence:** Source review of commit `aa8bf43` and user-provided audit, 2026-09-29.
**Current Truth:** `docs/agentic/ARCHITECTURE.md` / Constraints
**Blueprint Requirements:** all
**Roadmap Outcomes:** OUT-001 through OUT-010
**Supersedes:** none

### DEC-0004: Verified outcome is the learning label

**Area:** Learning truth
**Decision:** Only an independently verified, untainted outcome can label a TrainingExample; LLM agreement is shadow evidence only.
**Rationale:** Agreement measures imitation, not correctness, and can promote systematic errors.
**Alternatives:** Use fallback LLM choice as label; use user messages alone.
**Evidence:** `packages/brain/src/cascade.ts` and `packages/brain/src/calibration.ts` at `aa8bf43`.
**Current Truth:** `docs/agentic/PRODUCT.md` / Product Rules
**Blueprint Requirements:** REQ-FUNC-003, REQ-PERF-001
**Roadmap Outcomes:** OUT-006, OUT-007
**Supersedes:** none

### DEC-0005: Provenance belongs to content parts

**Area:** Provenance boundary
**Decision:** Result trust and taint attach to origin-bearing data parts; trusted server metadata cannot bless externally authored content.
**Rationale:** Tool annotations describe behavior hints and do not establish the trust of every returned principal or text fragment.
**Alternatives:** One boolean per tool descriptor; one taint bit per task.
**Evidence:** `packages/mcp/src/map.ts` and `packages/agent/src/runtime.ts` at `aa8bf43`.
**Current Truth:** `docs/agentic/SECURITY.md` / Authorization
**Blueprint Requirements:** REQ-SEC-001, REQ-FUNC-005
**Roadmap Outcomes:** OUT-003, OUT-008
**Supersedes:** none

### DEC-0006: Durable RunEngine is the runtime center

**Area:** Runtime center
**Decision:** Persistent Session/Run state and checkpointed transitions become the center of orchestration; lane ordering remains a concurrency primitive, not state.
**Rationale:** Per-call history and process-local lanes cannot support recovery, long missions, memory, or verified outcomes.
**Alternatives:** Persist a chat message array only; add retry logic around the existing loop.
**Evidence:** `packages/agent/src/runtime.ts` and `packages/core/src/lane-queue.ts` at `aa8bf43`.
**Current Truth:** `docs/agentic/ARCHITECTURE.md` / Interfaces
**Blueprint Requirements:** REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002
**Roadmap Outcomes:** OUT-002
**Supersedes:** none

### DEC-0007: Official SDK behind an August MCP adapter

**Area:** MCP protocol boundary
**Decision:** Use the maintained official MCP SDK for negotiation and transport behind a stable August adapter; preserve legacy support only with consumer evidence and a sunset.
**Rationale:** Handwritten protocol transport is high-churn infrastructure and not the product differentiator.
**Alternatives:** Continue extending the custom JSON-RPC clients; bind domain code directly to SDK types.
**Evidence:** `packages/mcp/src/client.ts` and `packages/mcp/src/http.ts` at `aa8bf43`; exact current SDK/protocol behavior must be verified from primary sources during OUT-004.
**Current Truth:** `docs/agentic/ARCHITECTURE.md` / Adapters
**Blueprint Requirements:** REQ-OPS-001
**Roadmap Outcomes:** OUT-004
**Supersedes:** none

### DEC-0008: Release claims require current evidence

**Area:** Release claims
**Decision:** Source presence, unit tests, or README statements do not establish delivered runtime behavior; claims require current revision-bound verification.
**Rationale:** The clean baseline currently has one hanging red-team test and unavailable typecheck, while several advertised capabilities are not integrated.
**Alternatives:** Treat the merged MVP commit or documentation as acceptance.
**Evidence:** Local `bun test` and `bun run typecheck` on 2026-09-29; `docs/agentic/VERIFICATION.md`.
**Current Truth:** `docs/agentic/PROJECT-BLUEPRINT.md` / Release Boundaries
**Blueprint Requirements:** REQ-REL-003, REQ-OPS-002
**Roadmap Outcomes:** OUT-001, OUT-010
**Supersedes:** none

### DEC-0009: OUT-001 routes an exact ignored execution binding

**Area:** OUT-001 execution selection
**Decision:** OUT-001 names ignored `docs/superpowers/progress/OUT-001.md` as its current execution-selection owner; that record binds exact accepted Foundation, Design Spec, Application Receipt, and Implementation Plan identities before each downstream phase.
**Rationale:** Artifact status, filenames, dates, and conversational memory cannot select current work, while mutable execution progress should not rewrite the Foundation for each phase transition.
**Alternatives:** Embed mutable spec/plan revisions in ROADMAP.md; infer the newest artifact; create a global selection registry.
**Evidence:** Superpowers Architecture product-evolution and Foundation lifecycle selection contract, verified 2026-09-29.
**Current Truth:** `docs/agentic/ROADMAP.md` / OUT-001 Execution Binding
**Blueprint Requirements:** REQ-REL-003, REQ-OPS-002
**Roadmap Outcomes:** OUT-001
**Supersedes:** none

### DEC-0010: Bun 1.1.39 is the minimum runtime

**Area:** Bun runtime floor
**Decision:** AugustAgents requires Bun 1.1.39 or newer; text `bun.lock` is the authoritative dependency lockfile.
**Rationale:** Bun 1.1.39 introduced text `bun.lock`. No current consumer evidence justifies maintaining a second binary lockfile or compatibility branch for 1.1.0–1.1.38.
**Alternatives:** Preserve ambiguous Bun 1.1+ with dual `bun.lock`/`bun.lockb`; require Bun 1.2+; omit a support floor.
**Evidence:** Official Bun lockfile docs and guide, verified 2026-09-29: https://bun.sh/docs/pm/lockfile and https://bun.sh/guides/install/yarnlock. Current development host runs Bun 1.4.2; exact 1.1.39 compatibility remains an OUT-001 acceptance gate.
**Current Truth:** `docs/agentic/ARCHITECTURE.md` / Technology Stack
**Blueprint Requirements:** REQ-REL-003, REQ-OPS-002
**Roadmap Outcomes:** OUT-001, OUT-010
**Supersedes:** none

### DEC-0011: Autonomous document progression

**Area:** Workflow approval
**Decision:** Exact internally reviewed Foundation, Design Spec, Implementation Plan, and consequential public-document revisions may progress as Ready under Workflow Policy Version 2 without repeated user approval prompts; external-action and publication boundaries remain unchanged.
**Rationale:** After repeated Review-gated stops, the user explicitly stated that all work was permitted and ordered development to continue without further document-approval delay on 2026-09-29.
**Alternatives:** Continue Review-gated document-by-document approval; remove lifecycle review entirely.
**Evidence:** User messages “Все разрешаю” and “ДОРАБАТЫВАЙ МОЙ ПРОЕКТ ... Я ТЕБЕ УЖЕ ВСЕ РАЗРЕШИЛ” in the current task, 2026-09-29.
**Current Truth:** root `AGENTS.md` / Workflow Policy
**Blueprint Requirements:** all
**Roadmap Outcomes:** OUT-001 through OUT-010
**Supersedes:** DEC-0001

### DEC-0012: OUT-002 routes an exact ignored execution binding

**Area:** OUT-002 execution selection
**Decision:** OUT-002 names ignored `docs/superpowers/progress/OUT-002.md` as its current execution-selection owner; that record binds exact policy-accepted Foundation, Design Spec, Application Receipt, and compatible Implementation Plan identities before implementation.
**Rationale:** Durable runtime work changes persistence and recovery boundaries; exact current selection must remain resumable without rewriting Foundation state for every phase.
**Alternatives:** Infer newest artifacts; reuse OUT-001 progress; embed mutable revisions directly in ROADMAP.md.
**Evidence:** Superpowers Architecture selection contract and successful OUT-001 binding workflow, verified 2026-09-29.
**Current Truth:** `docs/agentic/ROADMAP.md` / OUT-002 Execution Binding
**Blueprint Requirements:** REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002
**Roadmap Outcomes:** OUT-002
**Supersedes:** none

### DEC-0013: SQLite adapter implements durable state and run seams

**Area:** OUT-002 persistence adapter
**Decision:** Use one Bun SQLite `runtime.db` adapter in WAL mode to implement separate logical StateStore and RunStore interfaces, with schema version 1 and atomic local transactions.
**Rationale:** Bun SQLite is already used by the runtime, the evidenced deployment is one local process, and one cohesive adapter keeps message/run/checkpoint/idempotency transactions local without leaking persistence into channels or AgentRuntime.
**Alternatives:** Separate message/run databases; EventJournal as content store; JSON files; external workflow engine.
**Evidence:** Existing `bun:sqlite` EventJournal implementation, target interfaces in ARCHITECTURE.md, and OUT-002 consumer/recovery requirements reviewed 2026-09-29.
**Current Truth:** `docs/agentic/ARCHITECTURE.md` / Technology Stack, Interfaces, Adapters, Data Durability
**Blueprint Requirements:** REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002
**Roadmap Outcomes:** OUT-002
**Supersedes:** none
