# Roadmap

## Outcome Order

This is the complete user-authorized destination. Implement directly and close
outcomes only with full live acceptance. Superpowers specifications, plans and
receipts are historical records and do not gate development. Dependencies below
are product/verification prerequisites, not documentation ceremonies.

### OUT-001: Reproducible baseline and truthful release status

**Intent:** A clean checkout has pinned dependencies, runnable typecheck, a non-hanging green test baseline, and public status documents that match observed behavior.
**Blueprint Requirements:** REQ-REL-003, REQ-OPS-002
**Decision Prerequisites:** DEC-0008, DEC-0009
**Dependencies:** none
**Readiness:** Ready for implementation
**State:** Proposed
**Completion Note:** Credential regression repaired at 6c4a2d5: 579 pass, 12 skip, 0 fail; real encrypted CLI recovery/rotation passes with zero native-store calls. Full OUT-001 remains open for useful real-model task/restart acceptance. Preserve original baseline/prepared-plan contracts.
**CI Increment:** Issue #1 infrastructure now runs frozen restore and named skip/failure artifacts on real hosted Ubuntu/macOS/Windows, plus sidecar lint/protocol and corrupt-lock rejection. Native Linux's 12 previously skipped containment checks ran and passed; native macOS sidecar reverse-DNS startup was repaired. Actual source/run-bound results are in VERIFICATION. Windows remains NOT_QUALIFIED with named permission/path/socket/process failures; completing this CI increment does not complete OUT-001 or authorize releases.

### OUT-002: Durable session and run engine

**Intent:** Sessions, messages, runs, transitions, checkpoints, budgets, pause/resume/cancel, retry, and idempotency survive process restart without duplicate effects.
**Blueprint Requirements:** REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002
**Decision Prerequisites:** DEC-0006
**Dependencies:** OUT-001
**Readiness:** Blocked
**State:** Implementing
**Completion Note:** Historical integration 227fa56 supplied Phase A/schema-v2 but did not establish acceptance. Current schema-v3 adds durable model attempts, tariff snapshots, unresolved holds and explicit owner reconciliation; actual pause/reconcile/same-run continuation and cancel/crash journeys pass locally. Provider degradation/cooldown, broader external-effect/platform/production recovery and complete outcome acceptance remain open. Do not treat this increment as completion of OUT-002 or the full goal.

### OUT-003: Content provenance and replay-safe approvals

**Intent:** Result parts preserve origin/trust/sensitivity, writes are target-aware controlled effects, and every channel resolves only one bound non-replayable approval.
**Blueprint Requirements:** REQ-SEC-001, REQ-SEC-002, REQ-ACC-001
**Decision Prerequisites:** DEC-0005
**Dependencies:** OUT-001
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** Source at aeef0aa exists; current live replay/target/provenance acceptance remains outstanding.

### OUT-004: Maintained MCP protocol adapter

**Intent:** Replace handwritten lifecycle/version negotiation with the current official SDK behind the stable August capability interface, with tested and sunset-bound compatibility only where justified.
**Blueprint Requirements:** REQ-OPS-001, REQ-REL-003
**Decision Prerequisites:** DEC-0007
**Dependencies:** OUT-001, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** Official SDK 1.31.0 is pinned in packages/mcp/package.json and frozen install succeeds. Live interoperable peers and protocol acceptance remain outstanding.

### OUT-005: Capability supply chain and execution containment

**Intent:** Community executable capabilities are artifact-verified, sandbox-required, deny-by-default for egress, and receive secrets through a scoped broker; skills retain untrusted provenance and explicit effects.
**Blueprint Requirements:** REQ-SEC-003, REQ-OPS-002
**Decision Prerequisites:** DEC-0005, DEC-0007
**Dependencies:** OUT-003, OUT-004
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** Main includes artifact/broker/skill source; 12 platform/capability tests skip on this macOS host. Skips do not establish containment.

### OUT-006: Outcome-verified learning and segmented calibration

**Intent:** Decisions, executions, observations, verifier evidence, rewards, and calibration keys produce training examples only after verified untainted outcomes; activation uses outcome evals rather than LLM agreement.
**Blueprint Requirements:** REQ-FUNC-003, REQ-PERF-001
**Decision Prerequisites:** DEC-0004, DEC-0006
**Dependencies:** OUT-002, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** ff8c2c9 adds verified-learning source; current real-weight learning/activation acceptance is outstanding.

### OUT-007: Runtime-integrated distillation engine

**Intent:** AgentRuntime selects LLM, skill, workflow, or reflex from verified histories, generates evals, measures value, and safely promotes, audits, or demotes each task pattern.
**Blueprint Requirements:** REQ-FUNC-004, REQ-PERF-001, REQ-REL-002
**Decision Prerequisites:** DEC-0004, DEC-0006
**Dependencies:** OUT-002, OUT-006
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** bccd5d9 adds integrated compilation source; fresh real-model matched-task promotion/demotion acceptance is outstanding.

### OUT-008: Provenance-aware memory engine

**Intent:** Working, episodic, semantic, and procedural memory persist with provenance, lifecycle, retrieval evaluation, owner controls, and deletion semantics.
**Blueprint Requirements:** REQ-FUNC-005, REQ-SEC-001
**Decision Prerequisites:** DEC-0005, DEC-0006
**Dependencies:** OUT-002, OUT-003
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** a7d4b02 adds memory source. Live isolation/lifecycle acceptance and the requested vector/file-backed contract remain outstanding.

### OUT-009: Tamper-evident audit and encrypted secret fallback

**Intent:** Audit history has protected keyed/signed anchors and the server/container fallback secret store is encrypted with recoverable key management.
**Blueprint Requirements:** REQ-SEC-004, REQ-REL-001
**Decision Prerequisites:** DEC-0006
**Dependencies:** OUT-002, OUT-005
**Readiness:** Blocked
**State:** Proposed
**Current Evidence:** e596112 adds encrypted fallback/audit source. Two macOS secret tests fail; live key rotation/recovery and protected-anchor acceptance remain outstanding.

### OUT-010: Cross-platform core release gate

**Intent:** Linux, macOS, and Windows builds, live sandbox/egress evidence, restart/recovery, protocol integration, red-team, supply-chain, signing, SBOM/provenance, updater/rollback, and frontend journeys support a truthful production decision.
**Blueprint Requirements:** REQ-ACC-001, REQ-REL-003, REQ-OPS-002 and release evidence for every active requirement
**Decision Prerequisites:** DEC-0008
**Dependencies:** OUT-002, OUT-003, OUT-004, OUT-005, OUT-006, OUT-007, OUT-008, OUT-009
**Readiness:** Blocked
**State:** Proposed
**Platform Risk:** Hosted matrix execution is implemented, but Windows runtime/ACL/portability failures and native frontend/recovery/packaging/signing gates remain unresolved. The optional Docker ARM64 runner executes real jobs but cannot establish Windows/macOS support; its unavailable bubblewrap namespaces remain failed isolation evidence, not passes.

## Remaining Full-Goal Outcomes

Implement the outcomes below in dependency order; their prerequisites need
current acceptance. DEC-0015 preserves the full destination. This table records
product outcomes; it does not require Superpowers phase entry or artifact binding.

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
