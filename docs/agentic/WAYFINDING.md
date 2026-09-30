# AugustAgents project navigation


**Workflow:** Direct development; Superpowers disabled by the user on 2026-09-29.

Historical lifecycle revisions and receipts remain in Git/ignored local records.
They are not active approval, planning or implementation prerequisites.

## Document owners

- `AGENTS.md`
- `CONTEXT.md`
- `docs/agentic/AGENTS.md`
- `docs/agentic/WAYFINDING.md`
- `docs/agentic/USER-GOAL.md`
- `docs/agentic/PROJECT-BLUEPRINT.md`
- `docs/agentic/PRODUCT.md`
- `docs/agentic/DOMAIN.md`
- `docs/agentic/ARCHITECTURE.md`
- `docs/agentic/SECURITY.md`
- `docs/agentic/DECISIONS.md`
- `docs/agentic/ROADMAP.md`
- `docs/agentic/VERIFICATION.md`

## Destination

A user-agreed Foundation covering the complete supplied Laya platform goal,
preserving its security constraints, and distinguishing current source,
current runtime evidence, and outstanding acceptance for every outcome.

## Readiness Checklist

- Project identity, current maturity, and release boundary are explicit.
- Stable requirements map to every roadmap outcome.
- Architecture and security owners distinguish delivered behavior from target
  behavior.
- Reset authority, external actions, and publication permissions are explicit.
- The first outcome is bounded and has no unresolved product decision.
- Root `AGENTS.md` owns direct development and authority boundaries.
- Baseline failures and unavailable checks are recorded as failures or unknown,
  never as passes.

## Frontier

- Continue direct in-scope development; Superpowers is disabled for this project.
- Complete the remaining OUT-001 live-provider/task acceptance after the verified
  credential regression repair; retain the complete roadmap destination.
- Repair live provider/tool journeys, then continue remaining source integration
  and product acceptance in roadmap order.

## Fog

- Number and identity of active external users or installations.
- Whether any existing installation contains retained runtime data that must be
  migrated rather than rebuilt.
- Real macOS, Linux, and Windows release environments and signing identities.
- Production support commitments, service-level expectations, and release
  cadence.

## Out of Scope

- Publication, live payments, third-party messages, cloud provisioning, and
  migration/reset of retained user data without separate scoped authority.
- Missing embedded diagrams are unavailable source material; do not invent them.
- Deleting the current codebase or replacing all packages at once.
- Claiming production readiness before `OUT-010` evidence exists.
- Resetting user/runtime data or publishing releases without separate authority.

## Decision Pointers

- Workflow and phase policy: [DEC-0017](DECISIONS.md#dec-0017-disable-superpowers-for-this-project), [DEC-0002](DECISIONS.md#dec-0002-same-session-phase-mode). Superseded history remains at DEC-0001 and DEC-0011.
- Full destination: [DEC-0015](DECISIONS.md#dec-0015-complete-laya-platform-goal).
- Incremental architecture strategy: [DEC-0003](DECISIONS.md#dec-0003-preserve-and-evolve-the-current-codebase).
- Learning truth and provenance: [DEC-0004](DECISIONS.md#dec-0004-verified-outcome-is-the-learning-label), [DEC-0005](DECISIONS.md#dec-0005-provenance-belongs-to-content-parts).
- Runtime and protocol direction: [DEC-0006](DECISIONS.md#dec-0006-durable-runengine-is-the-runtime-center), [DEC-0007](DECISIONS.md#dec-0007-official-sdk-behind-an-august-mcp-adapter).
- Evidence-gated release claims: [DEC-0008](DECISIONS.md#dec-0008-release-claims-require-current-evidence).

## Optional Document Justification

`docs/agentic/SECURITY.md` is required because the product executes untrusted
capabilities with secrets and external effects; the security contract is too
large and durable to live as a subsection of architecture.

[USER-GOAL.md](USER-GOAL.md) preserves the supplied original goal verbatim so
contributors and CI can read it without the owner's filesystem. Requirements
and source-section links are owned by [PROJECT-BLUEPRINT.md](PROJECT-BLUEPRINT.md).
The original contains three embedded-diagram placeholders but no diagram assets;
their absence is preserved, not filled with invented diagrams.
