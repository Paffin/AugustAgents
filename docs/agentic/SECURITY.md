# Security

## Assets And Threats

Assets include user messages/files, model credentials, capability secrets,
runtime state, approval authority, external accounts, learning data, and audit
history. Threats include prompt injection, malicious packages/skills, protocol
peers, secret exfiltration, replay/confused approvals, duplicated effects after
restart, tainted learning, and local database tampering.

## Authentication

- Local gateway authentication, Host/Origin checks, loopback binding, and
  Telegram allowlists remain active constraints.
- Capability publisher and artifact identity must be independently verifiable;
  registry presence or version strings are insufficient.

## Authorization

### Observed at `aa8bf43`

- The current policy evaluates descriptor effects, task-level taint,
  destination, mandates, and a channel response.
- Current Telegram inline callbacks use generic approve/deny values and are not
  bound to an action identity.

### Target contract — not delivered at `aa8bf43`

- Policy authorizes effects using descriptor, destination, provenance,
  sensitivity, budgets, mandates, and user approval.
- Local `write` is not universally safe; target and provenance determine the
  decision.
- Approval records bind approval id, nonce, session, tool, canonical action
  hash, creation, expiry, status, and resolver identity/channel.
- Old UI controls or text replies cannot resolve a different pending action.

## Privacy

- Send only the minimum StateView required by a model or verifier.
- Preserve origin and sensitivity on result and memory parts.
- Tainted/unverified records never enter personal training datasets.
- Logs store bounded metadata and hashes; any content retention needs an
  explicit owner-facing policy.

## Secrets

### Observed at `aa8bf43`

- OS credential stores are preferred.
- The current file fallback stores owner-readable plaintext JSON.

### Target contract — not delivered at `aa8bf43`

- File fallback must become encrypted at rest using a master key outside the
  data directory.
- Executable capabilities receive credentials through a scoped broker where
  practical; environment delivery requires artifact identity, required
  sandboxing, and destination-restricted egress.
- Secrets never enter prompts, approval callbacks, logs, or error text.

## Recovery

### Target contract — not delivered at `aa8bf43`

- External effects use idempotency records and checkpoint-before-effect order.
- Persistent-schema changes require backup, migration, validation, and rollback
  evidence.
- No user/runtime data reset is authorized by the current Foundation.

## Audit

### Observed at `aa8bf43`

- A plain recomputable SHA chain detects accidents but not an attacker who can
  rewrite the database.

### Target contract — not delivered at `aa8bf43`

- The target contract uses a keyed or signed chain with a protected key plus
  periodic external/append-only anchors.
- Audit verification reports gaps and never repairs history silently.

## Security Verification

- Every security fix includes a reproducing exploit/invariant regression test
  and relevant red-team coverage; under the selected no-TDD workflow those tests
  may be authored after implementation.
- Red-team coverage includes compromised-model assumptions in Russian and
  English.
- Capability tests cover pre-start exfiltration, not only tool-call behavior.
- Mixed trusted/untrusted result content verifies part-level provenance.
- Approval tests include stale button/message replay, cross-session resolution,
  action drift, expiry, and concurrency.
- Sandbox/egress/secret claims require live platform evidence in addition to
  argument-construction tests.
