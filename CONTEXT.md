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

Convert the 2026-09-29 audit of `main` at commit `aa8bf43` into ordered,
review-gated roadmap outcomes. Restore a reproducible green baseline before
changing runtime architecture.

## Active Risks

- One real-app red-team test hangs beyond both 5 s and 10 s.
- Type checking is not currently runnable in the clean checkout because
  dependencies and a lockfile are absent.
- Session/run durability, outcome-verified learning, integrated distillation,
  and memory are not delivered.
- MCP execution, output provenance, approvals, skill trust, secrets, and audit
  integrity have known security gaps.

## Roadmap Position

Foundation creation is in review. `OUT-001` is the first implementation outcome
after this Foundation is Approved.

## Reading Links

- Product and maturity: `docs/agentic/PRODUCT.md`
- Architecture: `docs/agentic/ARCHITECTURE.md`
- Security: `docs/agentic/SECURITY.md`
- Ordered tasks: `docs/agentic/ROADMAP.md`
- Verification evidence: `docs/agentic/VERIFICATION.md`

