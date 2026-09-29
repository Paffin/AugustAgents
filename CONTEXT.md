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

Continue provider configuration and budget correctness after the live-runtime
repair at 2081216. Real web file reading and useful continuation after restarting
the process passed. Superpowers is disabled; develop directly against the full
requirements and 28-outcome roadmap.

## Active Risks

- Linux/Windows/CI, real Laya weights, live sandbox/egress, signing, updater,
  and recovery evidence remain unverified.
- Source for budgets, learning, distillation, and memory exists; full acceptance
  remains outstanding. Current local file/restart journeys pass, but latency is
  high and broader failure/platform scenarios are not yet qualified.
- Credential tests are isolated; production Keychain namespace/plaintext fallback
  remain risks. Provider pricing/dates still contain fixed values. Reported usage
  now includes decision and empty replies; unreported timeout billing is unknown.
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
