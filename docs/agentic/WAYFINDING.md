# AugustAgents Wayfinding

**Artifact Type:** Agentic Foundation
**Status:** Ready
**Revision:** sha256:d6f1e6e7f017f8046d669fea5aac2af0a06c1a7c49b1ac4ddf92f45525cf050f
**Approved Revision:** none
**Approved At:** none

## Foundation Files

- `AGENTS.md`
- `CONTEXT.md`
- `docs/agentic/AGENTS.md`
- `docs/agentic/WAYFINDING.md`
- `docs/agentic/PROJECT-BLUEPRINT.md`
- `docs/agentic/PRODUCT.md`
- `docs/agentic/DOMAIN.md`
- `docs/agentic/ARCHITECTURE.md`
- `docs/agentic/SECURITY.md`
- `docs/agentic/DECISIONS.md`
- `docs/agentic/ROADMAP.md`
- `docs/agentic/VERIFICATION.md`

## Destination

A policy-accepted OUT-002 Phase A closeout that records verified local durable
runtime behavior, preserves the provider-usage/pricing completion blocker, and
keeps all remaining release gaps explicit.

## Readiness Checklist

- Project identity, current maturity, and release boundary are explicit.
- Stable requirements map to every roadmap outcome.
- Architecture and security owners distinguish delivered behavior from target
  behavior.
- Reset authority, external actions, and publication permissions are explicit.
- The first outcome is bounded and has no unresolved product decision.
- Workflow Policy Version 2, Approval Policy, and Phase Mode are durably owned
  by root `AGENTS.md` and are validated independently.
- Baseline failures and unavailable checks are recorded as failures or unknown,
  never as passes.

## Frontier

- Complete exact implementation/final/security review and local fast-forward
  integration of OUT-002 Phase A.
- Design the bounded OUT-002 provider-usage/pricing successor without widening
  into later provenance, learning, memory, or release outcomes.

## Fog

- Number and identity of active external users or installations.
- Whether any existing installation contains retained runtime data that must be
  migrated rather than rebuilt.
- Real macOS, Linux, and Windows release environments and signing identities.
- Production support commitments, service-level expectations, and release
  cadence.

## Out of Scope

- Browser automation, voice, devices, A2A, payments, teams, and cloud features.
- Deleting the current codebase or replacing all packages at once.
- Claiming production readiness before `OUT-010` evidence exists.
- Resetting user/runtime data or publishing releases without separate authority.

## Decision Pointers

- Workflow and phase policy: [DEC-0011](DECISIONS.md#dec-0011-autonomous-document-progression), [DEC-0002](DECISIONS.md#dec-0002-same-session-phase-mode). Superseded history remains at [DEC-0001](DECISIONS.md#dec-0001-review-gated-project-documents).
- Incremental architecture strategy: [DEC-0003](DECISIONS.md#dec-0003-preserve-and-evolve-the-current-codebase).
- Learning truth and provenance: [DEC-0004](DECISIONS.md#dec-0004-verified-outcome-is-the-learning-label), [DEC-0005](DECISIONS.md#dec-0005-provenance-belongs-to-content-parts).
- Runtime and protocol direction: [DEC-0006](DECISIONS.md#dec-0006-durable-runengine-is-the-runtime-center), [DEC-0007](DECISIONS.md#dec-0007-official-sdk-behind-an-august-mcp-adapter).
- Evidence-gated release claims: [DEC-0008](DECISIONS.md#dec-0008-release-claims-require-current-evidence).

## Optional Document Justification

`docs/agentic/SECURITY.md` is required because the product executes untrusted
capabilities with secrets and external effects; the security contract is too
large and durable to live as a subsection of architecture.
