# Verification

## Quality Policy

Completion claims bind the exact revision, command, environment, result, and
known limitations. Source review and isolated unit tests do not substitute for
frontend journeys, restart/recovery, platform isolation, or release evidence.

The latest user requires no hardcoded substitutes and no smoke-based acceptance.
Use full useful journeys with real model/backend/tool state, independently inspect
the outcome, and include negative, restart, budget and rollback branches relevant
to that journey. Existing fake-adapter invariant tests remain useful engineering
coverage but do not satisfy the live acceptance gate. Do not replace existing
attack coverage with tests that merely mirror implementation.

Before running credential tests, inspect their backend selection: temporary HOME
or CliIo.home alone does not isolate macOS Keychain/Secret Service. Do not rerun
the unsafe suite until backend fixtures are isolated and verified. That repair
is recorded below. Account for every skip; platform-inapplicable is not a pass.

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
  through a reviewed change that preserves supported consumers and the active goal.
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

Review each coherent change against affected modules, interfaces, seams and
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

### Live-provider repair at 2081216, 2026-09-29

- Typecheck/full gate exit 0: 586 pass, 12 skip, 0 fail, 2180 expectations,
  598 tests/35 files; tests 8.90 s, combined wall 10.11 s on macOS/Bun 1.4.2.
- Actual local Qwen through the web UI read a random order.json with reference
  50804b44ab5eb256 and amount 31676, then returned the correct amount+19=31695.
  The run persisted completed/1 tool step, 1033 input and 1742 output tokens.
- A second gateway process opened the same owned state. Without repeating the
  numbers, the next web request returned the original reference/amount and the
  correct amount+24=31700. It persisted completed/0 tool steps, 667 input and
  1381 output tokens; this was conversation continuation, not another file read.
- First/second elapsed times were 173.50 s / 35.95 s: useful behavior passes,
  latency remains a gap. Both owned gateways and the browser were stopped;
  foreign model processes were preserved. Evidence captures remain local.
- Empty/truncated replies report valid usage before error, decision calls are
  metered, and generation/retry callbacks enforce current controls. Invalid
  usage (including null/unsafe integers) fails closed. Timeout responses without
  usage cannot establish exact billing and remain an explicit limitation.
- No real Laya, full platform isolation, clean release matrix or production
  recovery claim is established by these local journeys.

### Credential-regression closeout at 6c4a2d5, 2026-09-29

- Real encrypted backend injection isolates App/CLI/provenance fixtures from
  native owner stores. Focused: 61 pass/0 fail, red-team: 38 pass/0 fail.
- Full suite: 579 pass, 12 skip, 0 fail, 2156 expectations, 591 tests/35 files,
  8.89 s; combined typecheck/test gate exit 0, wall 10.02 s on macOS/Bun 1.4.2.
- Actual CLI seal/copy/separate-key recovery/rotate/full-value readback, old-key
  rejection and list/remove passed on random synthesized owned data; native
  process calls 0. Values and recovery codes were not printed.
- Useful live-model file/restart acceptance remains open. The previous native
  Keychain value has not been restored; no verified original backup exists.
- Repository presentation at f7cb009 was approved and locally browser-rendered;
  that does not establish runtime acceptance or a GitHub render.

### Current revalidation at main e596112, 2026-09-29

- Frozen `bun install --frozen-lockfile` restored 92 missing packages without a
  tracked lockfile change. Bun 1.4.2, Node 26.0.0, macOS arm64.
- `bun run check`, outside the restricted network sandbox: typecheck exit 0;
  tests 577 pass, 12 skip, 2 fail, 2142 expectations, 591 tests/35 files, 10.54 s;
  combined exit 1. Both failures in secrets-at-rest.test.ts incorrectly expect
  encrypted-file while platform selection returns Keychain.
- A diagnostic focused run reproduced 10 pass/2 fail. One CLI test wrote a
  synthetic OPENAI_API_KEY into the shared `august` Keychain service. Whether it
  replaced a pre-existing value is unknown; there is no verified backup. Further
  runs are stopped, and no credential value appears in this evidence.
- Real browser against the real loaded local Qwen endpoint: a randomly generated
  order.json file was not read for the Russian user request; the response denied
  filesystem access. The English request failed with provider “response had no
  text”. The known-file/random-values check prevents fabricated success.
- An attempted restart journey was affected by the same provider failure;
  complete live recovery is not established by a successful gateway restart.
- Full evidence and UI captures live in ignored
  `docs/superpowers/progress/2026-09-29-goal-review.md`. Previous baseline records
  below apply to their named revisions and do not override these current failures.

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
  `affc38c`, macOS, Bun `1.4.2`: `/usr/bin/time -p bun run check` exits 0 with
  331 tests, 0 failures, 962 expectations across 17 files in 3.04 s.
- Two separate real CLI processes shared one exact temporary HOME and the
  loaded local no-key model `unsloth/Qwen3.8-Flash-Next-GGUF`: the first stored
  `NEPTUNE-7429`; after process exit, the second answered with that exact word.
  The temp config had no `apiKeyEnv`, no secrets file existed, and runtime bytes
  contained no `sk-` or `Bearer ` marker.
- With the app stopped and WAL at zero bytes, the exact `runtime.db` copy matched
  SHA-256 `92814d3c7a91da90dd1ce5fc45010b22a86df50b8910640f7bda375de1cd5bf9`.
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
- Final Codex Security diff scan `7c689f46-08ce-4d95-82ca-aa1331351432`
  covered all six changed source files in exact range `96bdde9..affc38c` after
  the final cancellation-race repair; coverage is complete with zero findings.
- OUT-002 Phase A does not verify provider token/cost accounting, production
  recovery, schema migration, multi-process coordination, or release readiness.
- No current CI run, clean-platform matrix, real Laya weights, live Linux
  sandbox/egress, Windows sandbox, release signing, updater, or recovery drill
  was verified in this Foundation pass.
