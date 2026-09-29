# Architecture

## Technology Stack

- Bun >=1.1.39 and TypeScript workspace packages for runtime, policy,
  capabilities, channels, gateway, MCP, discovery, ladder, and app composition.
  Bun 1.1.39 is the first release with text `bun.lock`; current development is
  observed on Bun 1.4.2. Sources: https://bun.sh/docs/pm/lockfile and
  https://bun.sh/guides/install/yarnlock, verified 2026-09-29.
- Python HTTP sidecar for Laya on loopback.
- Bun SQLite `runtime.db` with WAL is the selected OUT-002 adapter for durable
  conversation and run state behind logical StateStore and RunStore interfaces.
- Local filesystem and journal persistence; current storage contracts are
  package-specific and incomplete.

## Constraints

- Preserve current packages and public interfaces unless a policy-accepted Ready
  or preserved Approved bounded successor authorizes change.
- Runtime policy, provenance, and durable state must not depend on model
  obedience.
- Official protocol SDKs stay behind adapters and cannot leak transport types
  into domain packages.
- Unknown retained data or consumers block destructive migration shortcuts.

## Modules

### Observed at `aa8bf43`

- `core`: currently lane queue, session-key helpers, and hash journal; target
  owner for durable session/run/checkpoint interfaces.
- `agent`: orchestration of decision, arguments, policy, approval, execution,
  result, and response.
- `brain`: typed decision engines, Laya/LLM cascade, calibration, and providers.
- `policy`: effects, taint, mandates, and loop guards.
- `capabilities`: manifests, trust, registry, shortlist, and scanning.
- `mcp`: protocol/transport adapter, server host, mapping, and sandbox wrapper.
- `discovery`: registry lookup and installation plans for servers and skills.
- `channels` and `gateway`: owner-facing interaction and approval surfaces.
- `ladder`: currently an isolated promotion state machine; target distillation
  policy engine integrated through a small runtime interface.
- `app`: configuration, secret store, composition, CLI, and process lifecycle.

## Interfaces

### Target contract — not delivered at `aa8bf43`

- `StateStore`: logical interface to append/read session messages and produce
  bounded StateViews.
- `RunStore`: logical interface to atomically persist run states, steps,
  checkpoints, budgets, and idempotency records.
- `DurableRuntimeStore`: one cohesive SQLite adapter implementing both logical
  interfaces so conversation/run transactions stay local without collapsing
  their public responsibilities.
- `OutcomeVerifier`: verify an observed outcome without trusting the acting
  model.
- `TrainingSink`: accept only verified, untainted examples.
- `CapabilityRuntime`: execute one bound capability call through artifact,
  sandbox, egress, and secret brokers.
- `ApprovalStore`: create and resolve one exact expiring approval identity.
- `MemoryStore`: write/retrieve/delete provenance-aware memory classes.
- `McpAdapter`: present stable August tool descriptors over the maintained SDK.

## Seams

### Target contract — not delivered at `aa8bf43`

- Persistent storage sits behind `StateStore`, `RunStore`, and `MemoryStore`.
- Protocol/version behavior sits behind `McpAdapter`.
- OS isolation sits behind sandbox, egress, credential, and audit adapters.
- Owner channels sit behind approval and message interfaces.
- Model providers sit behind existing decision and generation interfaces.

## Adapters

### Observed and evolution contract

- Current MCP stdio/HTTP, Keychain/Secret Service/file store, Telegram, web, and
  Laya HTTP are adapters.
- `DurableRuntimeStore` is the selected local SQLite/WAL persistence adapter for
  OUT-002; channels remain unaware of storage details.
- Test fakes are justified only at these public seams and must preserve active
  safety contracts.
- No new compatibility adapter is justified until consumer, data, support
  window, removal condition, and reset/reseed insufficiency are evidenced.

## Data Flow

### Target contract — not delivered at `aa8bf43`

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
- `dataDir/runtime.db` schema v1 owns durable messages, runs, transitions,
  budgets, checkpoints, and idempotency records. It is additive and does not
  migrate or reset existing files.
- Current installed datasets and backup procedures are unknown.
- No authority exists to reset retained runtime/user data. Designs must define
  migration, backup, rollback, and recovery before changing persisted formats.

## Depth, Locality, And Leverage

### Target contract — not delivered at `aa8bf43`

- Durable state hides storage and recovery complexity behind small interfaces.
- Capability containment is enforced once below built-ins/skills/MCP adapters,
  not copied into each channel.
- Provenance travels with data parts, avoiding global booleans that lose origin.
- Learning and ladder policy consume outcome records rather than reimplementing
  execution observation.
- Protocol SDK changes remain local to the MCP adapter.

## Integration Shape

### Target contract — not delivered at `aa8bf43`

`app` composes channels, RunEngine, AgentRuntime, stores, policy, capability
runtime, verifiers, learning, and ladder. `agent` coordinates interfaces but
does not own persistence backends, protocol details, or OS isolation policy.

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

- SQLite/WAL and one cohesive adapter are selected for `OUT-002`; runtime
  behavior and recovery evidence remain undelivered until implementation.
- OS-specific network enforcement and sandbox primitives need current platform
  research and runtime evidence.
- The current agent loop creates `history` per message and is not durable.
- The current ladder, decision log, and journal are not integrated with verified
  run outcomes.
