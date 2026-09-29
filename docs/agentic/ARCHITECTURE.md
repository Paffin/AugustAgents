# Architecture

## Technology Stack

- Bun >=1.1.39 and TypeScript workspace packages for runtime, policy,
  capabilities, channels, gateway, MCP, discovery, ladder, and app composition.
  Bun 1.1.39 is the first release with text `bun.lock`; current development is
  observed on Bun 1.4.2. Sources: https://bun.sh/docs/pm/lockfile and
  https://bun.sh/guides/install/yarnlock, verified 2026-09-29.
- Laya supports in-process native CPU ONNX inference (`laya.onnx`) or a Python
  HTTP sidecar on loopback (`laya.url`), mutually exclusive. Native bundles pin
  weights, tokenizer, tokenizer configuration and prompt limits by SHA-256.
  Engine/calibration identity follows those contents, not a compiled model name.
  Backend loading is lazy; invalid/unavailable native assets yield primary errors
  and the cascade uses its LLM fallback. Native activation and local training
  remain subject to independently verified, engine-specific outcomes (OUT-011).
- Bun SQLite `runtime.db` schema v2/WAL now stores messages/runs/checkpoints and
  provider usage. Earlier Phase A evidence remains historical.
- Maintained MCP SDK 1.31.0 is pinned behind the existing August adapter.
- Local filesystem and journal persistence; current storage contracts are
  package-specific and incomplete.

## Constraints

- Change package/public interfaces only when needed for the authorized goal;
  inspect callers and verify retained behavior with each coherent change.
- Runtime policy, provenance, and durable state must not depend on model
  obedience.
- Official protocol SDKs stay behind adapters and cannot leak transport types
  into domain packages.
- Unknown retained data or consumers block destructive migration shortcuts.
- Runtime/provider/model/pricing inputs must come from validated configuration,
  measured metadata or calibrated policy. Fixed provider tariffs/dates and a
  heuristic standing in for Laya cannot meet the full goal.
- Later architecture outcomes and evidence are traced in the Blueprint; browser,
  voice, devices, wallet, agents and cloud remain required, with separate authority
  for actual external effects and infrastructure provisioning.

## Modules

### Current source, observed 2026-09-29

- `core`: lane queue, session keys, schema-v2 durable store with usage accounting,
  and audit/journal primitives. Current runtime acceptance is incomplete.
- `agent`: orchestration of decision, arguments, policy, approval, execution,
  result, and response.
- `brain`: typed decision engines, Laya/LLM cascade, calibration, and providers.
  Native ONNX serializes inference and releases its session on shutdown. Exact
  optional native dependencies are pinned; HTTP/LLM users do not import them.
- `policy`: effects, taint, mandates, and loop guards.
- `capabilities`: manifests, trust, registry, shortlist, and scanning.
- `mcp`: protocol/transport adapter, server host, mapping, and sandbox wrapper.
- `discovery`: registry lookup and installation plans for servers and skills.
- `channels` and `gateway`: owner-facing interaction and approval surfaces.
- `ladder`: promotion state plus compiled-plan routing integrated by `app`.
- `learning`: verified-outcome eligibility, traces, verifier registry and export.
- `memory`: scoped persistent memory and lexical retrieval; required editable
  files, vector retrieval and complete live owner controls remain incomplete.
- `app`: configuration, secret store, composition, CLI, and process lifecycle.

## Interfaces

### Current Phase A and target contracts

- `StateStore`: logical interface to append/read session messages and produce
  bounded StateViews.
- `RunStore`: logical interface to atomically persist run states, steps,
  checkpoints, budgets, and idempotency records.
- `DurableRuntimeStore`: one cohesive SQLite adapter implementing both logical
  interfaces so conversation/run transactions stay local without collapsing
  their public responsibilities.
- `AgentExecutionContext`: optional prior StateView, bounded scratch checkpoint,
  cooperative signal/deadline/effect/step budgets, and checkpoint observer.
- `App` run controls: inspect/list/pause/cancel/resume/retry/resolve plus optional
  idempotency keys while preserving existing `handle` callers.
- `OutcomeVerifier`: verify an observed outcome without trusting the acting
  model.
- `TrainingSink`: accept only verified, untainted examples.
- `CapabilityRuntime`: execute one bound capability call through artifact,
  sandbox, egress, and secret brokers.
- `ApprovalStore`: create and resolve one exact expiring approval identity.
- `MemoryStore`: write/retrieve/delete provenance-aware memory classes.
- `McpAdapter`: present stable August tool descriptors over the maintained SDK.

## Seams

### Current Phase A and target contracts

- Persistent storage sits behind `StateStore`, `RunStore`, and `MemoryStore`.
- TaintState and LoopGuard snapshots remain in `policy`; only opaque argument
  digests enter checkpoints, and malformed restore state fails closed.
- Protocol/version behavior sits behind `McpAdapter`.
- OS isolation sits behind sandbox, egress, credential, and audit adapters.
- Owner channels sit behind approval and message interfaces.
- Model providers sit behind existing decision and generation interfaces.

## Adapters

### Observed and evolution contract

- Current MCP stdio/HTTP, Keychain/Secret Service/file store, Telegram, web, and
  Laya HTTP/native ONNX are adapters.
- `DurableRuntimeStore` is the selected local SQLite/WAL persistence adapter for
  OUT-002; channels remain unaware of storage details.
- Test fakes are justified only at these public seams and must preserve active
  safety contracts.
- No new compatibility adapter is justified until consumer, data, support
  window, removal condition, and reset/reseed insufficiency are evidenced.

## Data Flow

### Web task controls

Completed responses expose the exact recorded learning-segment `feedbackId`.
Owner feedback targets that segment, with persisted session ownership and one
owner verdict per segment. It never resolves a base run-id to a later segment.
Web feedback includes both correlated run-id and feedback-id; CLI `/good` and
Telegram buttons retain the returned feedback-id. Task projections expose only
feedback identity/recorded status, not internal trajectory data. Paused/failed/
cancelled responses do not offer an answer-rating receipt. No schema migration
or new signing/nonce registry is introduced by this correlation repair.

GET `/v1/runs?channel&user&limit` projects recent durable run state, steps,
reported usage, configured budgets and safe-continuation eligibility. It does
not expose checkpoint history, arguments or other internal persistence fields.
POST `/v1/runs/:id` accepts a bound session and pause/cancel/resume action. App
checks the persisted session and safety state; gateway controls cannot manage
Telegram's separate transport. Resume enters the shared session lane; stops
bypass it so they can interrupt a busy message loop at its next safe boundary.

The browser polls real state while the panel is open. Long control requests do
not disable unrelated stop actions. Paused/cancelled replies are not offered
as independently verified successful answers. This is not a durable control-
intent protocol: in-flight stop requests and crash/budget edge cases still need
qualification before long-mission and team-control completion.

### Owner credential controls

The configured web gateway has a direct `GatewaySecrets` adapter to the secure
credential store, separate from the agent/message lane. GET `/v1/secrets` returns
backend identity and names only. PUT `/v1/secrets/:name` accepts only `{value}`
(1–8192 UTF-8 bytes); DELETE establishes absence within the managed name index.
Writes accept global uppercase names or `capability.NAME`, with bounded identifier
lengths. There is no credential value-reading HTTP route. Host/Origin/header-token
checks precede every operation; responses are no-store and backend errors opaque.
Plaintext stores do not expose the adapter. Journal events contain names/backend,
never submitted values; deletion records whether an entry changed. OS deletion
errors preserve the name index and report failure rather than a successful delete.

The browser provides separate password input, loading/error/disabled/success
states and explicit delete confirmation; values are cleared before submission
awaits and on panel close. Provider/MCP credential refresh is not automatic;
initial provider setup and the complete owner control center remain incomplete.

### Phase A observed flow and remaining target

Phase A persists the Run and current user message before execution, loads a
bounded prior StateView, commits safe/unsafe checkpoints around decision,
approval, and tool calls, then persists the assistant reply and terminal state
before returning. Restart marks interrupted active runs `recovering`; an unsafe
tool-start checkpoint requires explicit owner resolution and is never replayed
automatically. Session taint sources are reconstructed from durable checkpoints
for new, resumed, and retried runs, preventing untrusted tool content from
regaining clean-context authority after restart. The target flow below still includes later provenance, approval,
verification, learning, and containment outcomes.

1. Channel message is persisted under a Session.
2. RunEngine creates or resumes a Run and obtains a provenance-aware StateView.
3. Shortlist and decision select an explicit capability alternative.
4. Argument generation is validated against the bound descriptor.
5. Policy evaluates effects, provenance, destination, budgets, and mandates.
6. ApprovalStore resolves one exact action when required.
7. CapabilityRuntime applies artifact, sandbox, egress, and secret policy before
   execution.
8. Result parts retain provenance and update run state.
9. OutcomeVerifier records success, failure, or unresolved evidence.
10. Only verified, untainted records reach learning and distillation.
11. Response, checkpoint, and terminal state are persisted before reporting.

## Evolution And Compatibility Policy

The project is a prototype with unknown external consumers and mixed possible
local durability. Direct replacement is preferred for source-only behavior, but
retained runtime data is not assumed disposable. Schema or protocol
compatibility requires the five shared evidence items and a cleanup milestone.
The maintained MCP SDK may support legacy peers inside the adapter when real
consumer evidence justifies it; handwritten protocol logic is not a product
differentiator.

The build runtime floor is Bun 1.1.39 because it is the first release supporting
the committed text lockfile contract. No consumer evidence justifies a dual
binary/text lock compatibility path for earlier 1.1.x releases.

## Data Durability

- Repository source and tests are Git-managed.
- `~/.august` may contain retained configuration, decisions, journal, secrets,
  capability configuration, and future run/memory state.
- `dataDir/runtime.db` schema v2 owns messages, runs, transitions, budgets,
  usage, checkpoints and idempotency; source includes a v1 backup/migration path.
  No present retained-data migration or reset is authorized. Evaluate actual
  consumer/data/support-window evidence before extending compatibility.
- learning.db, patterns.db and memory.db are retained runtime datasets with
  owner/provenance boundaries; do not reseed them to achieve green tests.
- External retained installations and production backup procedures are unknown;
  one local stopped-app exact-file backup/read-only restore drill is verified.
- No authority exists to reset retained runtime/user data. Designs must define
  migration, backup, rollback, and recovery before changing persisted formats.

## Depth, Locality, And Leverage

### Current and target contract

- Durable state hides storage and recovery complexity behind small interfaces.
- Capability containment is enforced once below built-ins/skills/MCP adapters,
  not copied into each channel.
- Provenance travels with data parts, avoiding global booleans that lose origin.
- Learning and ladder policy consume outcome records rather than reimplementing
  execution observation.
- Protocol SDK changes remain local to the MCP adapter.

## Integration Shape

### Current Phase A and target contract

`app` source composes channels, durable state, policy, controls, outcome verifiers,
learning, memory, compilation and capability runtime. This integration is not
fully accepted live. `agent` coordinates
interfaces but does not own persistence backends, protocol details, or OS
isolation policy.

## Test Surface

- Product behavior: continuation, restart/resume, approval UX, learning, memory,
  and ladder journeys through app/public package interfaces.
- Safety/security: injection, replay, egress, artifact substitution, secret
  exfiltration, confused deputy, and tamper variants.
- External compatibility: official MCP SDK conformance and only evidenced legacy
  support, with explicit sunset.
- Temporary migration: persisted-format migration tests tied to cleanup tasks.
- Implementation detail: avoided unless the helper exposes an independent
  behavioral contract.

## Open Architecture Risks

- SQLite/WAL Phase A behavior, restart context, idempotency, safe/ambiguous
  recovery classification, and exact-file backup readback are locally verified;
  production recovery and schema migration remain unverified.
- OS-specific network enforcement and sandbox primitives need current platform
  research and runtime evidence.
- Provider usage/budget source exists; hardcoded pricing, provider empty-content
  behavior and live tool selection are current unresolved OUT-002 gaps.
- Learning/ladder/memory/audit are integrated in source; fresh matched-task,
  real-weight, recovery and platform acceptance remains outstanding.
- System Keychain uses one fixed service/account namespace across installations;
  secret tests currently escape temporary storage. Isolate before rerunning them.
- Plaintext fallback, local mutable anchor storage, missing native inference,
  actor supervisor and other complete-goal contracts require bounded designs.
