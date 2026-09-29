# Product

## Product Model

AugustAgents is a local-first agent runtime. Its differentiator is not generic
tool use but verified self-compilation: repeated successful work should move
from LLM execution to skill, workflow, and reflex while preserving policy,
provenance, recovery, and measurable success.

## Users And Roles

- **Owner:** operates the agent, approves effects, and controls local data.
- **Maintainer:** changes runtime, policies, adapters, tests, and releases.
- **Capability publisher:** supplies an MCP server or skill and is never trusted
  solely because the package is discoverable.
- **External principal:** authored data returned through a capability; trust is
  independent from the server code's trust.

## Maturity And Current Consumers

- **Maturity:** prototype.
- **Source:** repository `main` at `e596112`, observed 2026-09-29. Durable state,
  learning, memory, containment and audit code exists. Current live web journeys
  and test failures prevent readiness claims; source is not product acceptance.
- **Current users:** repository maintainers and possible public GitHub users;
  actual installations and active users are unknown.
- **External consumers:** unknown. The Git remote is public-facing, but no API,
  support-window, or deployed-service inventory was found in the checkout.
- **Durability:** local configuration, decision logs, event journal, secrets,
  and capability configuration may be retained; real installed datasets are
  unknown. No reset authority exists for user/runtime data.
- **Reassessment triggers:** first confirmed retained installation, first
  external compatibility promise, environment change, release candidate, or
  conflicting field evidence.

## Primary Workflows

1. Configure a model and local channels.
2. Continue a session and initiate a bounded run.
3. Discover or invoke a capability under policy.
4. Approve or deny one exact pending effect.
5. Verify the outcome and update learning/distillation state.
6. Inspect history, recover interrupted work, and understand failure.
7. Build and verify a reproducible release.

## Product Rules

- A model statement is never proof of action success.
- LLM agreement is never a correctness label.
- Tool/server trust is never equivalent to returned-content trust.
- Absence of a durability or consumer inventory is unknown, not permission to
  reset or drop compatibility.
- Safety and product claims must identify current evidence and observation
  boundaries.
- The complete supplied Laya document is the destination. MVP, v1, v2 and its
  next-generation inventions remain required; core safety prerequisites determine
  order, not scope reduction. Traceability lives in the Blueprint.
- Model and price selection use owner configuration or verified metadata;
  task-specific hardcoded answers and routing exceptions are forbidden.
- Complete live journeys establish acceptance. Mock-backed tests and smoke
  checks alone cannot close an outcome.

## UX Principles

- Show the action, destination, origin, effects, expiry, and reason for an
  approval request.
- Let the owner interrupt, revise, cancel, and resume work.
- Surface current run state and recovery options.
- Keep local-first privacy visible and avoid sending unneeded data to models.

## Product-Level Non-Goals

- General-purpose cloud orchestration in the current milestone.
- Background autonomy before durable owner controls and attention budgets pass.
- Marketing claims based only on source presence or isolated unit tests.

## Open Product Risks

- Real user count, current installations, and data-retention expectations are
  unknown.
- The current README describes some planned or partially implemented behavior
  as delivered.
- A release and support policy has not been established.
