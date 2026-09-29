# AugustAgents Project Blueprint

## Vision And Problem

Build a local-first personal agent that can act safely, persist across time, and
compile repeated successful work from expensive LLM execution into verified
skills, workflows, and reflexes. The present prototype has useful safety
primitives but lacks durable state and outcome-grounded learning.

## Target Users

- Primary: technical early adopters running an agent on their own machine.
- Secondary: developers extending the runtime with MCP servers and skills.
- Current real external users and deployments are unknown.

## Primary Journeys

1. A user continues a conversation or long-running mission across messages and
   process restarts.
2. The agent invokes a capability only inside explicit policy, provenance,
   approval, sandbox, network, and secret boundaries.
3. Execution produces an independently verified outcome that can become a
   trusted learning example.
4. Repeated verified work is promoted through the distillation ladder with
   measurable cost, latency, and success-rate improvement.
5. A maintainer can reproduce, test, audit, package, and recover a release.

## Goals

- Preserve the useful modular prototype while replacing unsafe or non-durable
  contracts through bounded outcomes.
- Make durable execution and verified outcomes the center of the runtime.
- Make capability provenance and containment enforceable below the model.
- Make documentation and release claims match observed behavior.

## Non-Goals

- Feature expansion into browser, voice, devices, A2A, payments, or cloud.
- Compatibility layers without a current consumer, durable data, support
  window, removal condition, and proof that rebuild/reseed is insufficient.
- Autonomous publication, deployment, or migration of user data.

## Success Measures

- A conversation and run resume correctly after a process restart in an
  integration test and a manual frontend journey.
- Laya training and activation use independently verified, untainted outcomes;
  LLM agreement remains a shadow metric only.
- Community executable capabilities cannot start without verified artifacts,
  required sandboxing, deny-by-default egress, and scoped secret delivery.
- Approval responses are bound to one pending action identity and cannot replay.
- Repeated tasks demonstrate a measured reduction in LLM calls, cost, and
  latency without lowering verified success rate.
- The full release matrix and security suites pass from a pinned dependency
  graph, with current evidence attached to the release decision.

## Release Boundaries

- Foundation gate: no implementation before the exact Foundation is Approved.
- Outcome gate: no implementation before the exact outcome Design Spec and Plan
  are Approved.
- Prototype gate: no README or release claim may say a capability is delivered
  without current runtime evidence.
- Production gate: production readiness is unavailable until `OUT-010` closes
  every required platform, recovery, security, and release check.

## Requirements

### Global Functional Requirements

- **REQ-FUNC-001 — Persistent conversation state.** Sessions retain ordered
  messages and state views across calls and restarts. Evidence: integration and
  frontend continuation journeys. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-FUNC-002 — Durable run engine.** Runs persist transitions,
  checkpoints, retries, idempotency, pause/resume/cancel, deadlines, and
  budgets. Evidence: restart and failure-injection tests. Owner:
  `ARCHITECTURE.md`. Status: planned.
- **REQ-FUNC-003 — Verified learning.** Training examples are produced only
  from verified, untainted outcomes with traceable decision and execution
  bindings. Evidence: negative and positive dataset tests. Owner:
  `ARCHITECTURE.md`. Status: planned.
- **REQ-FUNC-004 — Integrated distillation.** Runtime selects and supervises
  LLM, skill, workflow, and reflex execution with promotion, audit, and
  demotion. Evidence: end-to-end ladder journeys. Owner: `ARCHITECTURE.md`.
  Status: planned.
- **REQ-FUNC-005 — Provenance-aware memory.** Working, episodic, semantic, and
  procedural memory have explicit origin, lifecycle, retrieval, and deletion
  rules. Evidence: persistence, isolation, recall, and deletion tests. Owner:
  `ARCHITECTURE.md`. Status: planned.

### Accessibility Requirements

- **REQ-ACC-001 — Operable approval surfaces.** Terminal, web, and Telegram
  approval flows remain understandable and the web path remains keyboard
  operable with semantic labels. Evidence: frontend/manual journey and DOM
  checks. Owner: `PRODUCT.md`. Status: active constraint.

### Performance Requirements

- **REQ-PERF-001 — Measured self-compilation value.** Each ladder stage reports
  LLM calls, token/currency cost when available, wall-clock latency, and
  verified success rate under matched conditions. Evidence: benchmark record.
  Owner: `VERIFICATION.md`. Status: planned.

### Security And Privacy Requirements

- **REQ-SEC-001 — Content-level provenance.** Trust and taint attach to result
  parts and origins, not only tool metadata. Evidence: mixed-content injection
  tests. Owner: `SECURITY.md`. Status: planned.
- **REQ-SEC-002 — Bound approvals and writes.** Write policy is sensitive to
  target/provenance and every approval binds identity, nonce, action hash,
  session, and expiry. Evidence: replay and confused-deputy tests. Owner:
  `SECURITY.md`. Status: planned.
- **REQ-SEC-003 — Contained capability execution.** Executable community
  capabilities require artifact identity, publisher/provenance evidence,
  sandboxing, egress allowlists, and scoped secret brokering. Evidence:
  exfiltration and supply-chain tests. Owner: `SECURITY.md`. Status: planned.
- **REQ-SEC-004 — Durable secret and audit protection.** File fallback secrets
  are encrypted with an external master key and journal integrity is anchored
  by keyed/signature evidence outside the mutable chain. Evidence: theft and
  tamper tests. Owner: `SECURITY.md`. Status: planned.

### Reliability Requirements

- **REQ-REL-001 — Recovery without duplicate effects.** Restart, retry, and
  resume do not duplicate external actions. Evidence: crash-point matrix and
  idempotency tests. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-REL-002 — Bounded execution.** Every run enforces step, time, token,
  monetary, and external-effect budgets and accepts interrupt/cancel. Evidence:
  boundary tests. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-REL-003 — Reproducible green baseline.** Clean checkout dependency
  restore, typecheck, unit/integration/red-team suites, and public status claims
  are deterministic. Evidence: CI and local clean-run logs. Owner:
  `VERIFICATION.md`. Status: first outcome.

### Operational Requirements

- **REQ-OPS-001 — Maintained MCP adapter.** Protocol negotiation and transport
  behavior use a maintained official SDK behind the August capability boundary,
  with compatibility supported only by evidence. Evidence: official-SDK
  conformance tests, legacy-consumer inventory, and protocol integration tests
  tied to exact SDK/protocol versions. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-OPS-002 — Verifiable release supply chain.** Exact dependencies,
  checksums, SBOM/provenance, platform matrix, signed artifacts where applicable,
  upgrade/rollback, and release evidence are required. Evidence: clean-checkout
  CI artifacts, SBOM/provenance records, checksum/signature verification, and a
  successful upgrade/rollback drill. Owner: `VERIFICATION.md`. Status: planned.

## Project-Level UX And Visual Principles

Project-wide UX truth is owned by `PRODUCT.md` / UX Principles. This Blueprint
binds that owner through `REQ-ACC-001`, `REQ-SEC-002`, and `DEC-0008` without
restating the current interaction contract.

## Technology And Architecture Constraints

Project-wide technology and architecture truth is owned by `ARCHITECTURE.md` /
Constraints, Interfaces, and Test Surface. This Blueprint binds that owner
through `DEC-0003`, `DEC-0005`, `DEC-0006`, `DEC-0007`, and the requirements
mapped in Roadmap Traceability.

## Risks And Deferred Areas

- Existing external consumers and retained data are unknown.
- Windows native sandboxing and packaging are not delivered.
- macOS `sandbox-exec` longevity and Linux egress enforcement require current
  platform evidence during the relevant design.
- Browser/voice/devices/A2A/payments remain deferred until core runtime gates.

## Roadmap Traceability

| Outcome | Requirements advanced |
| --- | --- |
| OUT-001 | REQ-REL-003, REQ-OPS-002 |
| OUT-002 | REQ-FUNC-001, REQ-FUNC-002, REQ-REL-001, REQ-REL-002 |
| OUT-003 | REQ-SEC-001, REQ-SEC-002, REQ-ACC-001 |
| OUT-004 | REQ-OPS-001, REQ-REL-003 |
| OUT-005 | REQ-SEC-003, REQ-OPS-002 |
| OUT-006 | REQ-FUNC-003, REQ-PERF-001 |
| OUT-007 | REQ-FUNC-004, REQ-PERF-001, REQ-REL-002 |
| OUT-008 | REQ-FUNC-005, REQ-SEC-001 |
| OUT-009 | REQ-SEC-004, REQ-REL-001 |
| OUT-010 | REQ-ACC-001, REQ-REL-003, REQ-OPS-002 and release evidence for all active requirements |
