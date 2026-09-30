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

- Realize all MVP, v1, v2 and next-generation outcomes in the user source
  [USER-GOAL.md](USER-GOAL.md). Dependency order does not exclude features.
  Embedded diagrams are unavailable.
- Preserve the useful modular prototype while replacing unsafe or non-durable
  contracts through bounded outcomes.
- Make durable execution and verified outcomes the center of the runtime.
- Make capability provenance and containment enforceable below the model.
- Make documentation and release claims match observed behavior.

### Original Goal Source

[USER-GOAL.md](USER-GOAL.md) is the exact supplied document, not a rewritten
specification: 51,698 UTF-8 bytes, SHA-256
`d1f5b1727156fc0426fbb41a4c3a619c1c233f815fdfbccc11a74ea49169ace9`.
It preserves the original links and three embedded-diagram placeholders; the
diagram assets were not included in the supplied file. Nothing was omitted.
Its dated model/competitor claims are source context, not current qualification.
Later owner instructions, including useful live acceptance instead of smoke
checks, remain governed by [AGENTS.md](../../AGENTS.md).

Requirement source links below identify the originating behavior. Reliability,
accessibility and release checks also express implementation constraints derived
from that goal; a link is traceability, not a delivery claim.

## Non-Goals

- Hardcoded model/task/routing/price substitutes or smoke-based completion claims.
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

- Development: direct implementation and verification under the user's in-scope
  authority; Superpowers specifications, plans and lifecycle receipts are not gates.
- Prototype gate: no README or release claim may say a capability is delivered
  without current runtime evidence.
- Core gate: OUT-010 closes core platform, recovery and security evidence.
- Full-goal gate: OUT-028 closes every active requirement, including later
  features. Test counts and commit titles cannot establish completion percentage.

## Requirements

### Global Functional Requirements

- **REQ-FUNC-001 — Persistent conversation state.** Sessions retain ordered
  messages and state views across calls and restarts. Source:
  [Reliability and operations](USER-GOAL.md#надёжность-и-эксплуатация). Evidence: integration and
  frontend continuation journeys. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-FUNC-002 — Durable run engine.** Runs persist transitions,
  checkpoints, retries, idempotency, pause/resume/cancel, deadlines, and
  budgets. Source: [Reliability and operations](USER-GOAL.md#надёжность-и-эксплуатация).
  Evidence: restart and failure-injection tests. Owner:
  `ARCHITECTURE.md`. Status: planned.
- **REQ-FUNC-003 — Verified learning.** Training examples are produced only
  from verified, untainted outcomes with traceable decision and execution
  bindings. Source: [Next-generation inventions](USER-GOAL.md#изобретения-следующего-поколения).
  Evidence: negative and positive dataset tests. Owner:
  `ARCHITECTURE.md`. Status: planned.
- **REQ-FUNC-004 — Integrated distillation.** Runtime selects and supervises
  LLM, skill, workflow, and reflex execution with promotion, audit, and
  demotion. Source: [Distillation ladder](USER-GOAL.md#лестница-дистилляции).
  Evidence: end-to-end ladder journeys. Owner: `ARCHITECTURE.md`.
  Status: planned.
- **REQ-FUNC-005 — Provenance-aware memory.** Working, episodic, semantic, and
  procedural memory have explicit origin, lifecycle, retrieval, and deletion
  rules; editable md/yaml/jsonl, SQLite FTS5 and vector retrieval remain required.
  Source: [Features](USER-GOAL.md#фичи), [Security](USER-GOAL.md#безопасность).
  Evidence: live owner editing, persistence, isolation, measured retrieval, and
  physical deletion/readback. Owner:
  `ARCHITECTURE.md`. Status: planned.

### Accessibility Requirements

- **REQ-ACC-001 — Operable approval surfaces.** Terminal, web, and Telegram
  approval flows remain understandable and the web path remains keyboard
  operable with semantic labels. Source: [Features](USER-GOAL.md#фичи).
  Evidence: frontend/manual journey and DOM
  checks. Owner: `PRODUCT.md`. Status: active constraint.

### Performance Requirements

- **REQ-PERF-001 — Measured self-compilation value.** Each ladder stage reports
  LLM calls, token/currency cost when available, wall-clock latency, and
  verified success rate under matched conditions. Source:
  [Distillation ladder](USER-GOAL.md#лестница-дистилляции),
  [Success measures](USER-GOAL.md#стек-репозиторий-и-дорожная-карта).
  Evidence: benchmark record.
  Owner: `VERIFICATION.md`. Status: planned.

### Security And Privacy Requirements

- **REQ-SEC-001 — Content-level provenance.** Trust and taint attach to result
  parts and origins, not only tool metadata. Source: [Security](USER-GOAL.md#безопасность).
  Evidence: mixed-content injection
  tests. Owner: `SECURITY.md`. Status: planned.
- **REQ-SEC-002 — Bound approvals and writes.** Write policy is sensitive to
  target/provenance and every approval binds identity, nonce, action hash,
  session, and expiry. Source: [Trust and approval levels](USER-GOAL.md#уровни-доверия-и-аппрува).
  Evidence: replay and confused-deputy tests. Owner:
  `SECURITY.md`. Status: planned.
- **REQ-SEC-003 — Contained capability execution.** Executable community
  capabilities require artifact identity, publisher/provenance evidence,
  sandboxing, egress allowlists, and scoped secret brokering. Source:
  [Capability pipeline](USER-GOAL.md#конвейер). Evidence:
  exfiltration and supply-chain tests. Owner: `SECURITY.md`. Status: planned.
- **REQ-SEC-004 — Durable secret and audit protection.** File fallback secrets
  are encrypted with an external master key and journal integrity is anchored
  by keyed/signature evidence outside the mutable chain. Source:
  [Security](USER-GOAL.md#безопасность), [Next-generation inventions](USER-GOAL.md#изобретения-следующего-поколения).
  Evidence: theft and
  tamper tests. Owner: `SECURITY.md`. Status: planned.

### Reliability Requirements

- **REQ-REL-001 — Recovery without duplicate effects.** Restart, retry, and
  resume do not duplicate external actions. Source:
  [Reliability and operations](USER-GOAL.md#надёжность-и-эксплуатация). Evidence: crash-point matrix and
  idempotency tests. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-REL-002 — Bounded execution.** Every run enforces step, time, token,
  monetary, and external-effect budgets and accepts interrupt/cancel. Daily and
  per-tool token/cost limits plus actual UI accounting remain required. Source:
  [Features](USER-GOAL.md#фичи), [Reliability and operations](USER-GOAL.md#надёжность-и-эксплуатация). Evidence:
  boundary tests. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-REL-003 — Reproducible green baseline.** Clean checkout dependency
  restore, typecheck, unit/integration/red-team suites, and public status claims
  are deterministic. Source: [Stack, repository and roadmap](USER-GOAL.md#стек-репозиторий-и-дорожная-карта).
  Evidence: CI and local clean-run logs. Owner:
  `VERIFICATION.md`. Status: first outcome.

### Operational Requirements

- **REQ-OPS-001 — Maintained MCP adapter.** Protocol negotiation and transport
  behavior use a maintained official SDK behind the August capability boundary,
  with compatibility supported only by evidence. Source:
  [Capability connection](USER-GOAL.md#автоподключение-скилов-плагинов-и-mcp),
  [Stack](USER-GOAL.md#стек-репозиторий-и-дорожная-карта). Evidence: official-SDK
  conformance tests, legacy-consumer inventory, and protocol integration tests
  tied to exact SDK/protocol versions. Owner: `ARCHITECTURE.md`. Status: planned.
- **REQ-OPS-002 — Verifiable release supply chain.** Exact dependencies,
  checksums, SBOM/provenance, platform matrix, signed artifacts where applicable,
  upgrade/rollback, and release evidence are required. Source:
  [Installation](USER-GOAL.md#установка-и-настройка-в-3-касания). Evidence: clean-checkout
  CI artifacts, SBOM/provenance records, checksum/signature verification, and a
  successful upgrade/rollback drill. Owner: `VERIFICATION.md`. Status: planned.

### Additional Requirements From The Complete Goal

Each requirement below is proposed and pending user agreement. Project ownership
and complete live acceptance are explicit; detailed implementations need bounded
implementation and evidence. None is delivered solely by this document.

| Identity | Required behavior | Live acceptance | Owner |
| --- | --- | --- | --- |
| [REQ-FUNC-006](USER-GOAL.md#установка-и-настройка-в-3-касания) | Three-action signed single-binary installation; hardware/model/runtime detection, native service, web wizard, pairing, proxy/mirror/offline/resume, doctor, data-preserving uninstall | Fresh-host install to first useful reply on supported OSes | ARCHITECTURE.md |
| [REQ-FUNC-007](USER-GOAL.md#laya-multilingual-что-решает-и-как-её-не-сломать) | Real Laya native ONNX/MLX inference, typed choices, calibrated verified-outcome gates; JSON-schema generation; provider fallback/backoff/queued recovery; owner-selected model/pricing; personal model exams | Bilingual useful tasks, actual weights, outage/recovery and frozen exams | ARCHITECTURE.md |
| [REQ-FUNC-008](USER-GOAL.md#конвейер) | Local synchronized catalogs/offline mirrors; hierarchical retrieval and recall@16; signature/code/license checks; meaningful install acceptance/rollback; scoped OAuth refresh; dedup/version/effect/health controls; self-authored MCP if missing | Full discover-install-configure-action journey and hostile package rejection | ARCHITECTURE.md |
| [REQ-FUNC-009](USER-GOAL.md#фичи) | Durable heartbeat, natural-language schedules, MCP/webhook triggers, IANA timezones, quiet hours, digest and attention budget | Real timed tasks across restart, DST and quiet hours | PRODUCT.md |
| [REQ-FUNC-010](USER-GOAL.md#изобретения-следующего-поколения) | Web control center: onboarding, runs/missions, bounded always-mandates, journal/diffs/undo, memory/user profile, task/tool/day usage, skill attribution, demotion and weekly savings | Keyboard/browser journeys against actual persisted state | PRODUCT.md |
| [REQ-FUNC-011](USER-GOAL.md#фичи) | Official Telegram/web/CLI then Slack, Discord, email, WhatsApp Business, Matrix; OpenClaw/Hermes skill/plugin formats | Authenticated real channel messages and unknown-user/group restrictions | ARCHITECTURE.md |
| [REQ-FUNC-012](USER-GOAL.md#фичи) | Dedicated browser profile/accessibility actions, scoped subagents and external coding-agent delegation under common policy | Useful browser task and worker isolation/recovery | SECURITY.md |
| [REQ-FUNC-013](USER-GOAL.md#фичи) | Local STT/TTS and safe PDF/spreadsheet/image attachments | Real channel media task with provenance-preserving results | ARCHITECTURE.md |
| [REQ-FUNC-014](USER-GOAL.md#фичи) | OpenClaw/Hermes import, encrypted export/backup and another-host restore | Real state round-trip and corrupted/archive-escape rejection | ARCHITECTURE.md |
| [REQ-FUNC-015](USER-GOAL.md#ограничения-модели-и-наши-обходы) | Frozen holdouts, nightly local RLCD, export/calibration, three retained checkpoints, rollback and measured stage success/calls/cost/latency | Fresh train-to-runtime plus matched-task promotion/demotion | VERIFICATION.md |
| [REQ-FUNC-016](USER-GOAL.md#слабые-места-первой-версии-и-как-закрыты) | Long missions/milestones/reports; live steering/stop; isolated supervised channel/MCP actors with CPU/memory bounds | Actor crashes and mission restart without duplicate effects | ARCHITECTURE.md |
| [REQ-FUNC-017](USER-GOAL.md#изобретения-следующего-поколения) | Signed A2A identity/cards, untrusted inbound agents, wallet with bounded expiring payment mandates | Interoperability and provider sandbox transaction lifecycle; real payment requires separate authority | SECURITY.md |
| [REQ-FUNC-018](USER-GOAL.md#изобретения-следующего-поколения) | Paired device peripherals, CRDT offline sync, data-local compute, team roles/shared skills/member budgets, VPS/serverless/hibernation | Multi-node offline/reconnect and team isolation journeys | ARCHITECTURE.md |
| [REQ-FUNC-019](USER-GOAL.md#изобретения-следующего-поколения) | Opt-in malicious-hash/publisher reputation exchange and federated Laya learning with differential privacy | Multi-node exchange, consent and privacy-budget verification | SECURITY.md |
| [REQ-OPS-003](USER-GOAL.md#установка-и-настройка-в-3-касания) | Signed A/B updates, rehearsed copy migration, health rollback; OpenTelemetry local/owner-selected OTLP and decision explanations | Interrupted upgrade/rollback and real trace readback | VERIFICATION.md |
| [REQ-SEC-005](USER-GOAL.md#безопасность) | Speculative preview, file snapshots/trash, undo, delayed cancellable sending and no unapproved rights growth | Live preview/apply/undo and injection against all action adapters | SECURITY.md |

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
- Later outcomes wait for safety prerequisites and remain part of completion.
- External service accounts, signing identities and other OS hosts are unknown;
  unavailable live evidence cannot count as a pass.

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
| OUT-010 | REQ-ACC-001, REQ-REL-003, REQ-OPS-002 and core release evidence |
| OUT-011 | REQ-FUNC-007, REQ-REL-002 |
| OUT-012 | REQ-FUNC-006, REQ-OPS-002 |
| OUT-013 | REQ-FUNC-009, REQ-REL-001 |
| OUT-014 | REQ-FUNC-010, REQ-ACC-001, REQ-PERF-001 |
| OUT-015 | REQ-FUNC-008, REQ-SEC-003 |
| OUT-016 | REQ-FUNC-011, REQ-SEC-002 |
| OUT-017 | REQ-FUNC-015, REQ-FUNC-003, REQ-PERF-001 |
| OUT-018 | REQ-FUNC-014, REQ-REL-001 |
| OUT-019 | REQ-SEC-005, REQ-SEC-002 |
| OUT-020 | REQ-FUNC-012, REQ-SEC-003 |
| OUT-021 | REQ-FUNC-013, REQ-SEC-001 |
| OUT-022 | REQ-FUNC-016, REQ-REL-001, REQ-REL-002 |
| OUT-023 | REQ-OPS-003, REQ-OPS-002 |
| OUT-024 | REQ-FUNC-017, REQ-SEC-002, REQ-SEC-004 |
| OUT-025 | REQ-FUNC-018, REQ-REL-001, REQ-SEC-003 |
| OUT-026 | REQ-FUNC-019, REQ-SEC-001, REQ-SEC-004 |
| OUT-027 | REQ-FUNC-018, REQ-OPS-003, REQ-SEC-003 |
| OUT-028 | Full acceptance evidence for every active requirement |
