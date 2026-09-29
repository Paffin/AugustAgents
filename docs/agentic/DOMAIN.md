# Domain

## Canonical Language

- **Session:** durable conversational identity across messages.
- **Run:** durable execution instance that advances through explicit states.
- **StateView:** bounded, provenance-aware view presented to a decision model.
- **Decision:** typed choice among explicit alternatives.
- **Effect:** declared class of observable action such as read, write, network,
  send, pay, delete, or exec.
- **Approval:** owner authorization for one exactly bound pending action.
- **Mandate:** scoped, expiring authority for a class of actions.
- **Capability:** built-in, skill, or MCP-backed interface exposed to a run.
- **Provenance:** origin, principal, trust, sensitivity, and instruction ability
  attached to data.
- **Outcome:** observed post-execution state.
- **Verification:** independent method that classifies an outcome as success,
  failure, or unresolved.
- **TrainingExample:** verified, untainted decision/execution record eligible for
  learning.
- **Distillation stage:** LLM, skill, workflow, or reflex execution level.
- **Checkpoint:** durable recovery boundary in a run.

## Definitions

- **Trusted code** may be allowed to execute under policy; it does not make all
  data it returns trusted.
- **Controlled effect** requires policy evaluation and may require an approval
  or mandate.
- **Verified success** requires evidence outside the acting model's assertion.
- **Release evidence** is a current, reproducible record tied to a revision and
  environment.

## Invariants

- Every external effect belongs to one run and one policy decision.
- Every approval resolves only its bound action identity and cannot authorize a
  later action.
- Every training example binds a decision, execution, outcome, verifier, and
  provenance state.
- Every run transition is persistent before the next externally visible effect.
- Tainted or unresolved outcomes cannot promote learning or distillation.
- Compatibility and migration mechanisms have a real consumer and sunset.

## Relationships

- A Session contains ordered messages and references Runs.
- A Run contains Decisions, Tool Calls, Results, Outcomes, and Checkpoints.
- A Capability exposes tools; a tool call declares effects and produces
  provenance-bearing result parts.
- Verification converts an Outcome into evidence eligible or ineligible for a
  TrainingExample.
- Distillation consumes verified histories and selects a supervised stage.

## Rejected Synonyms

- Do not call a lane queue "memory" or "durable execution".
- Do not call LLM agreement "correctness" or "verified outcome".
- Do not call descriptor hashing "artifact pinning".
- Do not call a mutable SHA chain "immutable history".
- Do not call `sandbox: auto` with unrestricted network "contained execution".

## Open Domain Risks

- The exact boundary between Session, Conversation, Mission, and Run needs a
  bounded decision in `OUT-002`.
- Verification methods and reward semantics vary by task type and need a typed
  contract in `OUT-006`.

