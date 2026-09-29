# Roadmap

## Outcome Order

This is the proposed full destination, pending Foundation agreement. Each
outcome needs its own compatible Approved design/plan and complete live
acceptance before completion. Existing source is preserved; old ignored Ready
bindings and commit titles are historical evidence only. No code is authorized
by this Draft roadmap. Dependencies below are acceptance prerequisites.

### OUT-001: Reproducible baseline and truthful release status

**Intent:** A clean checkout has pinned dependencies, runnable typecheck, a non-hanging green test baseline, and public status documents that match observed behavior.
**Blueprint Requirements:** REQ-REL-003, REQ-OPS-002
**Decision Prerequisites:** DEC-0008, DEC-0009
**Dependencies:** none
**Readiness:** Ready for Brainstorming
**State:** Proposed
**Completion Note:** Reopened on main e596112: typecheck passes after frozen install, but 2 secret tests fail and access the host Keychain. Repair isolation before another full run; preserve theft/recovery invariants. The original complete outcome and accepted artifacts remain historical.
**Brainstorming Prompt:** Design only OUT-001 baseline regression repair from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md` at its exact Approved Foundation revision. Replace the old execution selection with distinct reviewed successors; preserve all active safety requirements and user data.
**Execution Binding:** `docs/superpowers/progress/OUT-001.md` is the ignored current-selection owner. Before Planning it must bind the exact accepted Foundation, Design Spec, and Application Receipt; before implementation it must also bind the compatible exact accepted Implementation Plan. Missing, stale, or ambiguous bindings block progression.

### OUT-002: Durable session and run engine

**Intent:** Sessions, messages, runs, transitions, checkpoints, budgets, pause/resume/cancel, retry, and idempotency survive process restart without duplicate effects.
**Blueprint Requirements:** REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002
**Decision Prerequisites:** DEC-0006
**Dependencies:** OUT-001
**Readiness:** Blocked
**State:** Implementing
**Completion Note:** Main includes Phase A plus schema-v2 usage/pricing source (227fa56). Current live provider/tool journeys fail, pricing has hardcoded fallbacks, and live budget/recovery acceptance is outstanding. Do not treat missing source as the blocker or this integration as completed acceptance.
**Brainstorming Prompt:** Design only OUT-002 live provider/tool/budget acceptance and in-scope repairs from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md` at its exact Approved Foundation revision; preserve state/provenance and replace historical bindings through distinct successors.
**Execution Binding:** `docs/superpowers/progress/OUT-002.md` is the ignored current-selection owner. It must bind exact policy-accepted Foundation, Design Spec, receipt, and compatible Implementation Plan identities before implementation; missing or stale bindings block progression.

### OUT-003: Content provenance and replay-safe approvals

**Intent:** Result parts preserve origin/trust/sensitivity, writes are target-aware controlled effects, and every channel resolves only one bound non-replayable approval.
**Blueprint Requirements:** REQ-SEC-001, REQ-SEC-002, REQ-ACC-001
**Decision Prerequisites:** DEC-0005
**Dependencies:** OUT-001
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** Source at aeef0aa exists; current live replay/target/provenance acceptance remains outstanding.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-003 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-004: Maintained MCP protocol adapter

**Intent:** Replace handwritten lifecycle/version negotiation with the current official SDK behind the stable August capability interface, with tested and sunset-bound compatibility only where justified.
**Blueprint Requirements:** REQ-OPS-001, REQ-REL-003
**Decision Prerequisites:** DEC-0007
**Dependencies:** OUT-001, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** Official SDK 1.31.0 is pinned in packages/mcp/package.json and frozen install succeeds. Live interoperable peers and protocol acceptance remain outstanding.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-004 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-005: Capability supply chain and execution containment

**Intent:** Community executable capabilities are artifact-verified, sandbox-required, deny-by-default for egress, and receive secrets through a scoped broker; skills retain untrusted provenance and explicit effects.
**Blueprint Requirements:** REQ-SEC-003, REQ-OPS-002
**Decision Prerequisites:** DEC-0005, DEC-0007
**Dependencies:** OUT-003, OUT-004
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** Main includes artifact/broker/skill source; 12 platform/capability tests skip on this macOS host. Skips do not establish containment.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-005 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-006: Outcome-verified learning and segmented calibration

**Intent:** Decisions, executions, observations, verifier evidence, rewards, and calibration keys produce training examples only after verified untainted outcomes; activation uses outcome evals rather than LLM agreement.
**Blueprint Requirements:** REQ-FUNC-003, REQ-PERF-001
**Decision Prerequisites:** DEC-0004, DEC-0006
**Dependencies:** OUT-002, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** ff8c2c9 adds verified-learning source; current real-weight learning/activation acceptance is outstanding.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-006 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-007: Runtime-integrated distillation engine

**Intent:** AgentRuntime selects LLM, skill, workflow, or reflex from verified histories, generates evals, measures value, and safely promotes, audits, or demotes each task pattern.
**Blueprint Requirements:** REQ-FUNC-004, REQ-PERF-001, REQ-REL-002
**Decision Prerequisites:** DEC-0004, DEC-0006
**Dependencies:** OUT-002, OUT-006
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** bccd5d9 adds integrated compilation source; fresh real-model matched-task promotion/demotion acceptance is outstanding.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-007 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-008: Provenance-aware memory engine

**Intent:** Working, episodic, semantic, and procedural memory persist with provenance, lifecycle, retrieval evaluation, owner controls, and deletion semantics.
**Blueprint Requirements:** REQ-FUNC-005, REQ-SEC-001
**Decision Prerequisites:** DEC-0005, DEC-0006
**Dependencies:** OUT-002, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** a7d4b02 adds memory source. Live isolation/lifecycle acceptance and the requested vector/file-backed contract remain outstanding.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-008 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-009: Tamper-evident audit and encrypted secret fallback

**Intent:** Audit history has protected keyed/signed anchors and the server/container fallback secret store is encrypted with recoverable key management.
**Blueprint Requirements:** REQ-SEC-004, REQ-REL-001
**Decision Prerequisites:** DEC-0006
**Dependencies:** OUT-002, OUT-005
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** e596112 adds encrypted fallback/audit source. Two macOS secret tests fail; live key rotation/recovery and protected-anchor acceptance remain outstanding.
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-009 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-010: Cross-platform core release gate

**Intent:** Linux, macOS, and Windows builds, live sandbox/egress evidence, restart/recovery, protocol integration, red-team, supply-chain, signing, SBOM/provenance, updater/rollback, and frontend journeys support a truthful production decision.
**Blueprint Requirements:** REQ-ACC-001, REQ-REL-003, REQ-OPS-002 and release evidence for every active requirement
**Decision Prerequisites:** DEC-0008
**Dependencies:** OUT-002, OUT-003, OUT-004, OUT-005, OUT-006, OUT-007, OUT-008, OUT-009
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-010 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

## Remaining Full-Goal Outcomes

For each outcome below, the canonical Brainstorming entry is: design only its
named OUT identity from the physical manifest
`/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`
at its exact Approved Foundation revision. All are Proposed and Blocked until
their dependencies have current acceptance; DEC-0015 is their direction
prerequisite. This table is outcome planning, not an implementation plan.

| Outcome | Observable intent | Requirements | Dependencies |
| --- | --- | --- | --- |
| OUT-011 | Native real Laya, resilient provider selection/fallback and personal model exams | REQ-FUNC-007, REQ-REL-002 | OUT-002, OUT-006 |
| OUT-012 | Three-action native installation/service and first useful paired-channel response | REQ-FUNC-006, REQ-OPS-002 | OUT-010, OUT-011 |
| OUT-013 | Durable schedules, heartbeat and attention-controlled digests | REQ-FUNC-009, REQ-REL-001 | OUT-002, OUT-003, OUT-011 |
| OUT-014 | Complete owner web control center, visible growth and real budgets | REQ-FUNC-010, REQ-ACC-001, REQ-PERF-001 | OUT-002, OUT-003, OUT-007, OUT-008 |
| OUT-015 | Full catalog/discovery/trust/OAuth/rollback capability lifecycle | REQ-FUNC-008, REQ-SEC-003 | OUT-004, OUT-005, OUT-011 |
| OUT-016 | Official remaining channels and OpenClaw/Hermes capability adapters | REQ-FUNC-011, REQ-SEC-002 | OUT-003, OUT-005, OUT-015 |
| OUT-017 | Actual local training/checkpoint rollback and measured distillation value | REQ-FUNC-015, REQ-FUNC-003, REQ-PERF-001 | OUT-006, OUT-007, OUT-011 |
| OUT-018 | Encrypted portability/import/backup restored on another host | REQ-FUNC-014, REQ-REL-001 | OUT-002, OUT-008, OUT-009 |
| OUT-019 | Speculative previews, snapshots/trash, undo and cancellable sends | REQ-SEC-005, REQ-SEC-002 | OUT-002, OUT-003, OUT-005, OUT-009 |
| OUT-020 | Browser and scoped delegated work through common action policy | REQ-FUNC-012, REQ-SEC-003 | OUT-005, OUT-019 |
| OUT-021 | Useful voice/media attachment journeys with content provenance | REQ-FUNC-013, REQ-SEC-001 | OUT-003, OUT-005, OUT-016 |
| OUT-022 | Long missions and supervised bounded actors with live steering/recovery | REQ-FUNC-016, REQ-REL-001, REQ-REL-002 | OUT-002, OUT-005, OUT-013, OUT-014 |
| OUT-023 | Signed A/B update, rehearsed migration/rollback and real OpenTelemetry | REQ-OPS-003, REQ-OPS-002 | OUT-009, OUT-010, OUT-012, OUT-018 |
| OUT-024 | Signed agent identity/interoperability and bounded wallet mandates | REQ-FUNC-017, REQ-SEC-002, REQ-SEC-004 | OUT-003, OUT-009, OUT-019 |
| OUT-025 | Paired peripherals and CRDT offline sync/data-local placement | REQ-FUNC-018, REQ-REL-001, REQ-SEC-003 | OUT-002, OUT-005, OUT-018, OUT-022 |
| OUT-026 | Opt-in collective immunity with enforceable privacy budget | REQ-FUNC-019, REQ-SEC-001, REQ-SEC-004 | OUT-005, OUT-009, OUT-017 |
| OUT-027 | Team roles/shared skills/member budgets and cloud hibernation | REQ-FUNC-018, REQ-OPS-003, REQ-SEC-003 | OUT-005, OUT-022, OUT-023, OUT-025 |
| OUT-028 | Every supplied-goal requirement demonstrated live, with complete release evidence | all active requirements | OUT-010 through OUT-027 |
