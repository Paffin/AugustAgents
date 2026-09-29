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

Reconcile the complete user goal and current `main` before further implementation.
Source at `e596112` includes changes labelled OUT-002 through OUT-009, but those
labels and the older OUT-002 binding do not establish current acceptance.
The proposed Foundation awaits document agreement.

## Active Risks

- Linux/Windows/CI, real Laya weights, live sandbox/egress, signing, updater,
  and recovery evidence remain unverified.
- Source for budgets, learning, distillation, and memory exists; complete live
  acceptance is outstanding. Real-model file reading failed in the current UI.
- Current secret tests choose the real macOS Keychain; isolate them before
  another full test run. Provider pricing and local dates contain fixed values.
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
