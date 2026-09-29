# Verification

## Quality Policy

Completion claims bind the exact revision, command, environment, result, and
known limitations. Source review and isolated unit tests do not substitute for
frontend journeys, restart/recovery, platform isolation, or release evidence.

## Test Strategy

- Behavior changes require meaningful public-interface regression tests; under
  the user-selected no-TDD workflow they may be authored after implementation,
  while existing reproducible failure evidence remains part of diagnosis.
- Maintain unit tests for deterministic contracts and integration tests for
  package composition.
- Exercise security invariants with compromised-model and hostile-capability
  cases.
- Exercise persistence through process restart and crash points.
- Verify user-facing flows through terminal/web/Telegram where applicable.

## Test Category Policy

- Every new or substantively changed durable test names its primary category
  and active contract in its title/comment or adjacent suite inventory. A
  uniform suite annotation is sufficient; mixed suites identify exceptions.
- Prototype-stage coverage defaults to product behavior and safety/security
  invariants. External compatibility and temporary migration tests require
  evidenced consumers/mechanisms and explicit sunset ownership.
- Untouched tests do not require retrospective categorization.
- **Product behavior:** session/run continuation, approval UX, learning, ladder,
  memory, and release behavior.
- **Safety/security invariant:** policy, provenance, replay prevention,
  sandbox/egress, secrets, audit, and injection coverage; retained while the
  boundary exists.
- **External compatibility contract:** MCP protocol/version support with current
  consumer evidence, support window, removal condition, and sunset. Retire only
  through a policy-accepted Ready or preserved Approved successor that preserves
  supported consumers.
- **Temporary migration test:** persisted-schema upgrade/rollback bound to one
  migration, removal milestone, accountable owner, and cleanup of production
  paths, fixtures, tests, docs, and formats.
- **Implementation detail:** replace with public-interface coverage unless the
  helper owns a real independent contract.

## Required Commands

- Dependency restore: `bun install --frozen-lockfile` after `OUT-001` creates
  and policy-accepts the lockfile contract.
- Type checking: `bun run typecheck`.
- Full suite: `bun test`.
- Combined gate: `bun run check`.
- Security changes: focused affected test plus
  `bun test packages/app/test/redteam.test.ts` and the full suite.
- Python sidecar: a real-model integration command remains unresolved and must
  be designed before its release gate.
- Platform sandbox/egress and packaging commands remain unresolved until the
  relevant outcomes select supported environments.

## Evidence Rules

- Record UTC/local date, Git revision, OS/runtime versions, command, exit code,
  pass/fail counts, elapsed time, and limitations.
- An unavailable dependency or environment is `cannot verify`, never a pass.
- One diagnostic rerun may distinguish noise; repeated reruns cannot select the
  best result.
- A release gate uses a clean checkout and pinned dependencies.

## Architecture Conformance

Every spec, plan, task, and final review reports modules, interfaces, seams and
adapters, data flow, depth/locality/leverage, public test surface, constraints,
stage appropriateness, consumer compatibility, subtraction, test categories,
sunset, and complexity budget.

## Security And Privacy Verification

Verify all active requirements in `SECURITY.md`, including pre-start capability
exfiltration, mixed provenance, stale/cross-session approval replay, idempotent
effects after crash, secret leakage, and database rewrite variants.

## Release Verification

Release evidence requires exact dependencies, SBOM/provenance, artifact
checksums/signatures where applicable, clean platform matrix, updater/rollback,
documentation truth, and no unresolved blocking security or recovery gap.

## Operational Verification

Run live frontend journeys, restart/resume scenarios, recovery drills, and real
MCP/Laya integration in supported environments. Capture observed behavior, not
only configuration intent.

## Current Baseline Evidence

- 2026-09-29, branch `main`, commit `aa8bf43`, macOS, Bun `1.4.2`, Node
  `v26.0.0`: `bun test` produced 295 pass and 1 fail. The failing real-app
  red-team install-injection case timed out at 5 seconds.
- One diagnostic focused rerun with `--timeout 10000` produced 37 pass and the
  same case timed out at 10 seconds. This is a reproducible hang, not accepted
  timing noise.
- `bun run typecheck` failed before type checking because `tsc` was not found;
  `node_modules` and a dependency lockfile were absent in the clean checkout.
- No current CI run, clean-platform matrix, real Laya weights, live Linux
  sandbox/egress, Windows sandbox, release signing, updater, or recovery drill
  was verified in this Foundation pass.
