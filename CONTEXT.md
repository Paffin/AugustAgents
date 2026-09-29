# AugustAgents Context

## Project Identity

AugustAgents is a local-first security-oriented agent runtime. The current
repository is a working prototype with strong policy primitives, but it is not
yet the durable, outcome-driven, self-compiling agent described by the product
vision.

## Foundation Manifest

The authoritative Agentic Foundation is listed in
`docs/agentic/WAYFINDING.md`.

## Current Focus

Continue native Laya integration, billing correctness and runtime acceptance.
Provider model discovery is implemented. Native CPU ONNX Laya is integrated in
App's shadow cascade; a useful web file/computation journey passed with real
recorded model probabilities. The host-native standalone runtime is also verified;
activation exam, local training and other platforms remain pending (see Verification).
Frozen prices were removed;
owner quotes and web task thresholds are validated. Real file reading, restart
and zero-cost admission journeys pass locally. Preserve the full 28-outcome goal.
Owner credential controls are now implemented and live-verified in the web UI:
direct encrypted writes, names-only lists, restart, failure and confirmed deletion.
First-run web setup and the rest of the complete control center remain open.
The web task panel now reads durable state/usage and controls safe pause,
cancel-further-work and continuation. Live pause/restart/continue passed for
one real file/computation task; unsafe recovery remains blocked.
Owner answer ratings now bind exact learning segments across Web/CLI/Telegram,
including persisted completed task cards after resume. Automated fixture feedback
is not a real human rating or activation qualification.
The user added competitive-quality UX across CLI/web/Telegram on 2026-09-30.
Responsive web workspace navigation and multi-line input are implemented;
CLI/TG commands now expose task state and safe continuation without using the
model for command routing. This is an initial functional UX increment, not
complete competitor parity. Live simultaneous CLI/gateway verification exposed
a shared-runtime startup defect: a second writable store marked a still-running
owner's tasks recovering. Ordinary store opens now leave active state alone;
App atomically claims an exclusive local-process owner before recovery. A second
CLI is refused without interrupting a live web task. CLI attachment to an existing
gateway and broader host/platform recovery qualification remain open.

## Active Risks

- Linux/Windows/CI, Laya activation exams, live sandbox/egress, signing, updater,
  and recovery evidence remain unverified.
- Source for budgets, learning, distillation, and memory exists; full acceptance
  remains outstanding. Current local file/restart journeys pass, but latency is
  high and broader failure/platform scenarios are not yet qualified.
- Credential tests are isolated; automatic plaintext fallback is removed.
  Key-folder containment is enforced, including symlinked ancestors and key files.
  Production Keychain namespace, host permissions and concurrent path changes remain risks.
  Runtime tariffs are now explicit; setup discovers models from
  the configured endpoint or requires an owner-entered identifier. Reported usage includes decision and empty replies;
  unreported timeout billing and quote changes across resumed runs remain gaps.
- Durable-runtime backup/readback is locally verified only; retained-data
  migration and production recovery remain unverified.
- MCP execution, output provenance, approvals, skill trust, secrets, and audit
  integrity have known security gaps.

## Roadmap Position

OUT-001 requires regression repair and renewed acceptance. OUT-002 through
OUT-009 have source changes with incomplete current runtime acceptance. OUT-010
is the core release gate; the full document goal continues through OUT-028.

## Reading Links

- Product and maturity: `docs/agentic/PRODUCT.md`
- Architecture: `docs/agentic/ARCHITECTURE.md`
- Security: `docs/agentic/SECURITY.md`
- Ordered tasks: `docs/agentic/ROADMAP.md`
- Verification evidence: `docs/agentic/VERIFICATION.md`
