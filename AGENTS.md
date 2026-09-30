# AugustAgents contributor instructions

## Goal and current work
Implement the full user goal in [USER-GOAL.md](docs/agentic/USER-GOAL.md).
Use `CONTEXT.md` for current work and `docs/agentic/ROADMAP.md` /
`PROJECT-BLUEPRINT.md` for requirements and dependencies. Preserve the complete
goal; individual commits or passing unit tests do not establish completion.

## Workflow
Superpowers and Superpowers Architecture are disabled for this project at the
user's explicit request on 2026-09-29. Work directly: inspect the relevant code,
implement the smallest coherent change, verify useful behavior live, review the
diff and commit completed stages. Specifications, plans, lifecycle hashes,
application receipts and phase ceremonies are not prerequisites for development.
Existing `docs/superpowers/` files are historical local records, not active gates.

The user has authorized all in-scope changes and asks for no over-engineering.
Use implementation-first verification, not TDD: implement the behavior, then
add/run meaningful regressions and live checks. Preserve existing test coverage.
Keep documentation consistent with verified behavior. Ask only when a real
product/authority decision or unavailable required access prevents progress.

## Constraints and verification
- Use real model/tool/backend state for acceptance. Preserve meaningful public
  regression and attack tests; synthetic responses do not establish live delivery.
- Model choices, prices and task behavior come from validated configuration or
  observed data. Hardcoded answers, model/tool-specific exceptions and smoke-based
  acceptance do not satisfy the goal.
- Preserve user changes, credentials and retained runtime data. Tests may modify
  only their unique process-owned synthesized temporary state; recreation means
  rerunning that fixture. Never access owner OS credentials from fixture tests.
- Run appropriate checks from `docs/agentic/VERIFICATION.md`; report skipped and
  unavailable platform checks honestly. Commit coherent verified increments,
  excluding secrets, runtime data and ignored generated material.
- Push, release publication, deployment, external messages/payments and reset of
  user data require separate scoped authority.

## Document owners
`docs/agentic/AGENTS.md` maps requirements, product, domain, architecture,
security, decisions, roadmap and evidence owners. Package manifests define
module boundaries. There are no child code instruction files.
