# Roadmap

## Outcome Order

### OUT-001: Reproducible baseline and truthful release status

**Intent:** A clean checkout has pinned dependencies, runnable typecheck, a non-hanging green test baseline, and public status documents that match observed behavior.
**Blueprint Requirements:** REQ-REL-003, REQ-OPS-002
**Decision Prerequisites:** DEC-0008, DEC-0009
**Dependencies:** none
**Readiness:** Ready for Brainstorming
**State:** Ready
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-001 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.
**Execution Binding:** `docs/superpowers/progress/OUT-001.md` is the ignored current-selection owner. Before Planning it must bind the exact accepted Foundation, Design Spec, and Application Receipt; before implementation it must also bind the compatible exact accepted Implementation Plan. Missing, stale, or ambiguous bindings block progression.

### OUT-002: Durable session and run engine

**Intent:** Sessions, messages, runs, transitions, checkpoints, budgets, pause/resume/cancel, retry, and idempotency survive process restart without duplicate effects.
**Blueprint Requirements:** REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002
**Decision Prerequisites:** DEC-0006
**Dependencies:** OUT-001
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-002 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-003: Content provenance and replay-safe approvals

**Intent:** Result parts preserve origin/trust/sensitivity, writes are target-aware controlled effects, and every channel resolves only one bound non-replayable approval.
**Blueprint Requirements:** REQ-SEC-001, REQ-SEC-002, REQ-ACC-001
**Decision Prerequisites:** DEC-0005
**Dependencies:** OUT-001
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-003 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-004: Maintained MCP protocol adapter

**Intent:** Replace handwritten lifecycle/version negotiation with the current official SDK behind the stable August capability interface, with tested and sunset-bound compatibility only where justified.
**Blueprint Requirements:** REQ-OPS-001, REQ-REL-003
**Decision Prerequisites:** DEC-0007
**Dependencies:** OUT-001, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-004 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-005: Capability supply chain and execution containment

**Intent:** Community executable capabilities are artifact-verified, sandbox-required, deny-by-default for egress, and receive secrets through a scoped broker; skills retain untrusted provenance and explicit effects.
**Blueprint Requirements:** REQ-SEC-003, REQ-OPS-002
**Decision Prerequisites:** DEC-0005, DEC-0007
**Dependencies:** OUT-003, OUT-004
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-005 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-006: Outcome-verified learning and segmented calibration

**Intent:** Decisions, executions, observations, verifier evidence, rewards, and calibration keys produce training examples only after verified untainted outcomes; activation uses outcome evals rather than LLM agreement.
**Blueprint Requirements:** REQ-FUNC-003, REQ-PERF-001
**Decision Prerequisites:** DEC-0004, DEC-0006
**Dependencies:** OUT-002, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-006 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-007: Runtime-integrated distillation engine

**Intent:** AgentRuntime selects LLM, skill, workflow, or reflex from verified histories, generates evals, measures value, and safely promotes, audits, or demotes each task pattern.
**Blueprint Requirements:** REQ-FUNC-004, REQ-PERF-001, REQ-REL-002
**Decision Prerequisites:** DEC-0004, DEC-0006
**Dependencies:** OUT-002, OUT-006
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-007 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-008: Provenance-aware memory engine

**Intent:** Working, episodic, semantic, and procedural memory persist with provenance, lifecycle, retrieval evaluation, owner controls, and deletion semantics.
**Blueprint Requirements:** REQ-FUNC-005, REQ-SEC-001
**Decision Prerequisites:** DEC-0005, DEC-0006
**Dependencies:** OUT-002, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-008 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-009: Tamper-evident audit and encrypted secret fallback

**Intent:** Audit history has protected keyed/signed anchors and the server/container fallback secret store is encrypted with recoverable key management.
**Blueprint Requirements:** REQ-SEC-004, REQ-REL-001
**Decision Prerequisites:** DEC-0006
**Dependencies:** OUT-002, OUT-005
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-009 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

### OUT-010: Cross-platform production release gate

**Intent:** Linux, macOS, and Windows builds, live sandbox/egress evidence, restart/recovery, protocol integration, red-team, supply-chain, signing, SBOM/provenance, updater/rollback, and frontend journeys support a truthful production decision.
**Blueprint Requirements:** REQ-ACC-001, REQ-REL-003, REQ-OPS-002 and release evidence for every active requirement
**Decision Prerequisites:** DEC-0008
**Dependencies:** OUT-002, OUT-003, OUT-004, OUT-005, OUT-006, OUT-007, OUT-008, OUT-009
**Readiness:** Blocked
**State:** Proposed
**Brainstorming Prompt:** Use the brainstorming skill to design roadmap outcome OUT-010 from `/Users/mkiktev/Documents/agents_system/AugustAgents/docs/agentic/WAYFINDING.md`, binding the exact Approved Agentic Foundation revision shown there at phase entry.

