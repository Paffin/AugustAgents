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

- 2026-09-29, branch `codex/audit-foundation`, implementation commit `b669434`,
  macOS, Bun `1.4.2`, Node `v26.0.0`: exact dev dependencies and text `bun.lock`
  are committed; `bun install --frozen-lockfile` and `bun run typecheck` exit 0.
- Checksum-verified official Bun `1.1.39` (`bun-darwin-aarch64.zip` SHA-256
  `d6d67a65959ae82c6f8df3478b9e0ff223eaeb6a09752f109d9b58b52f4c1b5a`)
  accepts the same lockfile with frozen dry-run exit 0.
- `bun test`: 297 pass, 0 fail, 837 expectations across 16 files in 2.00 s.
  The former install-injection timeout passes in about 4 ms; two public App
  sessions prove a later Registry response cannot replace or duplicate-consume
  the prepared plan.
- `/usr/bin/time -p bun run check`: exit 0, 2.58 s on the observed host.
- A real terminal CLI using temporary no-key configuration against
  `http://127.0.0.1:8888/v1` and loaded
  `unsloth/Qwen3.8-Flash-Next-GGUF` returned `PONG`. Command:
  `printf 'Ответь одним словом: PONG\nexit\n' | HOME="$AUGUST_SMOKE_HOME" bun packages/app/src/bin.ts chat`;
  exit 0; bounded output was `Ready. Type "exit" to quit.` followed by
  `you> PONG`. The exact temporary HOME was moved to Trash after inspection.
  Full inspectable local evidence is linked from ignored
  `docs/superpowers/progress/OUT-001-evidence.md`.
- 2026-09-29, branch `codex/out-002-durable-runtime`, implementation HEAD
  `b20afdf`, macOS, Bun `1.4.2`: `/usr/bin/time -p bun run check` exits 0 with
  331 tests, 0 failures, 960 expectations across 17 files in 3.07 s.
- Two separate real CLI processes shared one exact temporary HOME and the
  loaded local no-key model `unsloth/Qwen3.8-Flash-Next-GGUF`: the first stored
  `NEPTUNE-7429`; after process exit, the second answered with that exact word.
  The temp config had no `apiKeyEnv`, no secrets file existed, and runtime bytes
  contained no `sk-` or `Bearer ` marker.
- With the app stopped and WAL at zero bytes, the exact `runtime.db` copy matched
  SHA-256 `c3cde05f41349cc10601f964218d00001a33a00b9b8bba600e63059846d3c7e2`.
  Separate read-only `DurableRuntimeStore` opens reported schema 1, 4 messages,
  and 2 runs for both primary and backup; immutable backup open created no WAL
  or shared-memory sidecars. Task-owned temp directories were moved to Trash
  after inspection. Evidence is retained in ignored OUT-002 progress.
- Codex Security diff scan `06eee24c-82cd-45f8-9a18-c211ce719269`
  covered all six changed source files through `2ec7d34` and found one Medium
  cross-run provenance-loss issue. Commit `b20afdf` preserves durable session
  taint; the public two-App regression proves the later run asks under
  `tainted-context` while a clean session retains its mandate. Repair scan
  `54865ba1-f93b-48a9-9287-64b21ef37111` covered all three repair source files
  with zero findings and complete coverage.
- OUT-002 Phase A does not verify provider token/cost accounting, production
  recovery, schema migration, multi-process coordination, or release readiness.
- No current CI run, clean-platform matrix, real Laya weights, live Linux
  sandbox/egress, Windows sandbox, release signing, updater, or recovery drill
  was verified in this Foundation pass.
