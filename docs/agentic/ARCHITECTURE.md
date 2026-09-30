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
- Bun SQLite `runtime.db` schema v4/WAL stores messages/runs/checkpoints, received
  usage and durable model/tool attempts with tariff snapshots and unresolved holds.
  Earlier Phase A evidence remains historical.
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

- `core`: lane queue, session keys, schema-v3 durable store with usage accounting,
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
- `memory`: scoped persistent memory, editable file adapter, FTS/cosine rank
  fusion and opt-in local embedding transport. Source is integrated; complete
  live retrieval quality and browser owner-control qualification are in progress.
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
as independently verified successful answers. Durable owner stop intents are
persisted before an in-flight signal is sent; one live pause/cancel/crash path
passes locally. A repeated-call guard emits a typed failed stop, not Completed,
and is ineligible for distillation. Broader crash/budget/platform edge cases
still need qualification before long-mission and team-control completion.

Model context labels prior conversation as context only, separately from
observed results in the current run; the current request remains last for
bounded decision-state readers. Argument/final-answer context carries the same
separation. Choice instructions do not infer completion from an earlier answer
or guard stop. This is a generic prompt boundary, not a tool/model-specific
route, not independent verification and not native activation qualification.

### Owner-day and per-tool budget admission

The optional validated `budgets` policy selects an IANA `timeZone`, daily
token/cost limits and exact tool-ID call/token/cost limits. Absent limits mean
not configured, not zero. `BudgetLedger` reads `model_attempts`, `tool_attempts`
and legacy received totals from the existing runtime database; there is no
independent in-memory spend counter or new accounting service. Admission and
reservation share the same IMMEDIATE transaction. Snapshots use one read
transaction across all rows.

Actual argument-generation requests carry a host-selected tool ID. Expansion,
selection and final-answer usage are daily/run spend without invented tool
attribution. Each provider's refreshed output-price cap reaches its actual
request body, including retries/fallbacks. The transaction rejects known output
exposure beyond run/day/tool allowance instead of clipping the hold. Prompt
token quantities are not known before the receipt; quotes, held allowance and
provider token reports are not guarantees of an invoice ceiling.

`callCostMicros` is an optional owner flat estimate, not a fee inferred from MCP
output. Missing tool fees fail closed under a configured monetary cap; explicit
zero permits a free compiled call after model-budget exhaustion. Tool-call limits
still apply to compiled work. Unknown/in-flight model and tool holds survive
restart and carry across owner midnight; reported usage belongs to the request's
owner day. Legacy totals have no reconstructed per-tool provenance.

GET `/v1/budgets` projects this owner-wide snapshot under the existing gateway
authentication/Host/Origin guards. Web Tasks and CLI `/budgets` distinguish
received estimates, unresolved holds, missing quotes and unconfigured limits.
No model is used to route the CLI command. A dispatched tool transport exception
or uncertain MCP error response keeps `tool_started/safeToResume=false` and
stops further model/tool execution. Owner effect resolution does not silently
release an unresolved fee hold.

### Editable memory and local semantic retrieval

Memory remains in `memory.db` behind `MemoryStore`. An optional derived
`memory_vectors` table binds entry ID, configured weights/preprocessing identity
and exact text SHA; it does not alter primary entry identities or fabricate
semantic vectors. All store handles enable SQLite foreign keys, so forgetting
removes vectors even when embeddings are disabled. Owner edits overwrite the
active text/FTS and invalidate all cached vector identities. Queries filter
scope, active status, expiry, class and trust before indexing/retrieval. Hybrid
recall fuses lexical and cosine order by reciprocal rank, weighting lexical
contribution by measured query-term coverage; `.recall` remains the
lexical baseline and `recallHybrid` is the configured async path. Empty scopes
send no embedding query. Cancellation and changed/deleted documents fail closed
rather than associating a received vector with stale content.

Owner-editable files live outside capability-writable roots, by default in
`dataDir/memory/<scope-hash>/`. Semantic/procedural Markdown, `profile.yaml` and
`episodes.jsonl` mirror the same scoped entries. Confirmed published identities
track deletion; never-published DB writes are not erased after a publication
failure. File edits synchronize before reads, retain untrusted provenance, and
cannot resurrect tombstoned IDs. Reserved Markdown markers are escaped so tool
text cannot manufacture new trusted records. Static symlinks, oversized files,
duplicate IDs and credential-like text fail without resetting retained data.
Optimistic file checks/atomic replacement do not constitute qualification for
arbitrary concurrent editors or unsupported Windows filesystem behavior.

`memory.embedding` requires explicit loopback endpoint, model and identity;
query/document prefixes are configuration, never model-name exceptions. No
embedding model, prices or semantic responses are compiled into the product.
The default native HTTP(S) transport bypasses global proxy settings and enforces
TLS verification; Bun 1.4.2 fetch `proxy:false` was observed not to do so.
Loopback address validation is not proof of backend custody or network isolation.
CLI `memory search-fts` compares the baseline; `search` and held-out `eval` use
the configured hybrid path. Generative App composition still requires an owner
quote even for memory-only commands; a zero unused-fixture quote is not an
assertion about the foreign model's real tariff.

The owner-bound web Memory API projects only notes and safe metadata for the
fixed web/local scope. Trusted notes can be edited in place; untrusted notes are
view/delete-only, with no automatic trust operation. Permanent deletion removes
the lineage, FTS, vectors and mirrored text, leaving text-free tombstones. FTS
merge and verified WAL truncation occur after commit before acknowledging
physical erasure; a busy reader retains a durable pending marker and refuses
success. Startup retries or closes its storage/runtime ownership on refusal.
Source API/UI regressions and one real chat/edit/restart/recall/pre-close-delete
journey pass locally; broader privacy/custody/platform qualification remains open.

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
before returning. App first claims an exclusive local runtime owner in SQLite
metadata, in the same immediate transaction as recovery. A living or uncertain
PID blocks another App; a confirmed exited PID can be replaced. Close removes
only the owner's exact random receipt. Ordinary storage handles do not classify
active work as interrupted. This is a single-local-host contract, not a distributed
lease or support for shared network filesystems; CLI attachment to a running
gateway remains outstanding. Owner restart marks interrupted active runs `recovering`; an unsafe
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

## CI And Optional Repository Runner

`.github/workflows/ci.yml` restores the frozen lock, checks unchanged `bun.lock`
and runs the full engineering gate independently on hosted Ubuntu/macOS/Windows.
Each platform publishes JUnit, observed OS/sandbox metadata and a named skip
report. Linux missing bubblewrap evidence fails rather than silently accepting
skips. Python sidecar lint/protocol and corrupt-lock rejection have a separate
job; fake-adapter protocol coverage does not qualify actual model outcomes.

`docker/github-runner` is an optional Linux ARM64, one-job ephemeral GitHub
Actions runner, not an application deployment. The separate manual-main workflow
checks the exact approved SHA before any job step through an immutable hook.
Credentials and checkout live only in the owned container's private temporary
filesystems; no host source/home/socket is mounted. Native hosted macOS/Windows
remain required; Docker cannot replace those platform checks. Actual matrix/job
evidence and outstanding Windows portability gaps belong in `VERIFICATION.md`.

## Data Durability

- Repository source and tests are Git-managed.
- `~/.august` may contain retained configuration, decisions, journal, secrets,
  capability configuration, and future run/memory state.
- `dataDir/runtime.db` schema v4 owns messages, runs, transitions, budgets,
  usage, checkpoints, model/tool attempts and idempotency; source includes v1→v2→v3→v4
  verified backup/migration paths. App refuses live-owner migration, and busy
  WAL checkpoints refuse migration before creating an incomplete backup. Read-only
  image inspection is restricted to stopped/checkpointed snapshots, not live WAL.
  The v3 backup retains exact receipts, quotes, conversations and run IDs with
  owner-only permissions and a SHA-256 sidecar. A foreign-key failure rolls the
  v4 schema transaction back; no data reset or destructive downgrade is used.
  Migration has been exercised only on process-owned temporary state; unknown
  external retained datasets and production rollback are not qualified. No reset
  is authorized. Evaluate consumer/data/support-window evidence before extending
  compatibility.
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

### Configured provider degradation, 2026-09-30

`app/providers` composes the configured primary/optional backup and each owner's
quote. Endpoint/model-derived identities prevent alias/path changes from sharing
circuit state. `brain/FallbackProvider` owns closed/open/half-open admission,
bounded exponential cooldown, Retry-After and one recovery probe; `app` persists
failure/retry snapshots through the existing runtime metadata adapter. No new
database, schema migration, provider-name preset or tariff table is introduced.
Transport/usage persistence errors are fatal before another provider is selected.
The usage wrapper handles one receipt per actual attempt, including a charged
empty primary followed by a valid backup, without accepting duplicates.

Complete safe checkpoints carry providerRetryAt. A confirmed all-provider refusal
becomes durable waiting_external rather than a terminal model failure. The web
transport resumes eligible waits through its existing per-session LaneQueue;
pause/cancel, unknown billing and ambiguous effects never enter that path. Unknown
usage may retain a safe owner-reconcilable pause. Time limits are not reset by
recovery. Circuit status and catalog reachability are separate from inference
health/quality. Other-channel automation and provider-specific invoice/usage
reconciliation remain unqualified.

### External audit adapter, 2026-09-30

`core` owns signed anchor verification, bounded HTTP transport and idempotent
prefix publication. `app/audit-context` resolves the configured secret/CA,
composes read-only inspection and one periodic publisher; the existing signed
AnchorLog is the restart backlog, without another database or queue. Publication
does not block run-control aborts or await the model. `gateway` exposes owner-only
metadata status and `channels` renders coverage/outage warnings. Inspection never
constructs App; mutable signing/publication commands remain separate. Unknown
post-anchor removal is reported as unknown, not silently reconstructed history.

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
- Provider attempts now retain reported usage and immutable owner quotes;
  unreported calls hold allowance pending explicit reconciliation. Vendor invoice
  accuracy and configured cooldown/degradation remain unresolved OUT-002 gaps.
- Learning/ladder/memory/audit are integrated in source; fresh matched-task,
  real-weight, recovery and platform acceptance remains outstanding.
- System Keychain uses one fixed service/account namespace across installations;
  credential fixtures are now explicitly isolated, but live OS namespace work
  remains unqualified.
- Automatic plaintext fallback is removed, native CPU inference exists in shadow
  mode, and external anchor transport is integrated. Protected remote custody,
  key rotation continuity, activation/training, actor supervision and the rest
  of the complete goal still require implementation and acceptance.
