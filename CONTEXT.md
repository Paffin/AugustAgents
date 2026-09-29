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

`OUT-001` is integrated. `OUT-002` Phase A now has SQLite/WAL-backed durable
messages, runs, checkpoints, idempotency, restart context, owner controls, and
live local-model restart evidence. Close out and integrate Phase A, then add
provider-reported token usage and pricing before completing `OUT-002`.

## Active Risks

- Linux/Windows/CI, real Laya weights, live sandbox/egress, signing, updater,
  and recovery evidence remain unverified.
- Token and monetary budget enforcement, outcome-verified learning, integrated
  distillation, and provenance-aware memory are not delivered.
- Durable-runtime backup/readback is locally verified only; retained-data
  migration and production recovery remain unverified.
- MCP execution, output provenance, approvals, skill trust, secrets, and audit
  integrity have known security gaps.

## Roadmap Position

`OUT-001` is complete. `OUT-002` is In Progress: Phase A is implemented and
locally verified, but the outcome remains blocked from completion and cannot
unblock `OUT-003` until its usage/pricing successor is delivered.

## Reading Links

- Product and maturity: `docs/agentic/PRODUCT.md`
- Architecture: `docs/agentic/ARCHITECTURE.md`
- Security: `docs/agentic/SECURITY.md`
- Ordered tasks: `docs/agentic/ROADMAP.md`
- Verification evidence: `docs/agentic/VERIFICATION.md`
