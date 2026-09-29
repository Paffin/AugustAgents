# AGENTS.md

## Purpose

This directory contains the authoritative Agentic Foundation for AugustAgents.

## Ownership

- `WAYFINDING.md`: lifecycle manifest and navigation state.
- `PROJECT-BLUEPRINT.md`: stable requirements and roadmap traceability.
- `PRODUCT.md`: product model, users, maturity, workflows, and product rules.
- `DOMAIN.md`: canonical language and invariants.
- `ARCHITECTURE.md`: modules, interfaces, data flow, evolution, and test surface.
- `SECURITY.md`: durable security and privacy contract.
- `DECISIONS.md`: current decision index and immutable ledger.
- `ROADMAP.md`: bounded outcome order and phase entry points.
- `VERIFICATION.md`: quality policy, commands, and evidence expectations.

## Local Contracts

- Current truth is changed only in its owning document.
- Decision ledger entries are append-only; changed decisions append a
  superseding entry and update the current index.
- Every managed edit follows Draft, refresh, complete internal review, Ready,
  and exact Autonomous validation; preserved Approved history remains valid.
- Optional documents require justification in `WAYFINDING.md` and the manifest.

## Work Guidance

- Reconcile Blueprint requirements, roadmap outcomes, current decisions, and
  public documentation whenever a project-level contract changes.
- Preserve unknowns as unknown. Do not infer users, deployments, durable-data
  authority, compatibility promises, or production readiness.
- Keep implementation detail in bounded Design Specs and Plans, not here.

## Verification

Use the shared Foundation lifecycle operation. Never calculate or hand-edit the
canonical revision or approval metadata. Run all checks in
`VERIFICATION.md` applicable to a proposed progression.

## Child DOX Index

No child instruction boundaries exist below this directory.
