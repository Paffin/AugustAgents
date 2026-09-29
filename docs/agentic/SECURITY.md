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

### Current source and evidence, 2026-09-29

Content parts, bound approval ledger/callbacks, target-aware writes, verified
artifact installation, scoped secret broker, encrypted file backend and signed
journal anchors exist in source. The aa8bf43 observations above are historical.
Credential fixtures now use explicit owned backends; they do not access host
Keychain/Secret Service. Automatic encrypted-store selection fails closed when
master-key storage is unavailable and never falls back to plaintext. The CLI
returns a safe failure before asking for a credential and can retry after the
key-folder configuration is corrected. Explicit FileStore/legacy migration
tooling remains, without automatic selection on encryption failure.
The configured web UI now writes credentials through a direct owner-token API,
not through agent messages. No HTTP operation retrieves values. Plaintext
backends are disabled for these controls, request sizes/names are bounded, and
backend failures cannot echo values. Actual encrypted-store browser journeys
pass; OS-backend deletion failure is regression-tested at the Runner seam and
preserves names. Live OS credentials remain deliberately untouched/unqualified.
Current acceptance remains incomplete: live sandbox tests skip on this host;
the global `august` OS service/account can collide across installations;
key folders/key-file symlinks are checked against known data and tool roots
before use; host ACL/permission validation and concurrent path replacement remain open;
anchors are local mutable files. A signature alone does not establish protected external
anchoring or truncation resistance against replacement of all local evidence.

Tests may touch only process-owned fixture state. Credential-test selection must
be explicit at the backend seam and must never access a user's OS store. Preserve
the encryption/theft/tamper/recovery contract while fixing test isolation. Before
any later host credential test, use its own disposable backend/account namespace.
No runtime secret values are written into review packages or screenshots.

The broader action contract includes REQ-SEC-005, browser/worker/device adapters,
A2A wallet mandates and opt-in collective immunity. All consume common effects,
provenance, identity and budget checks below model reasoning. External services,
accounts, payments and publication still require scoped authority.

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

## CI Runner Boundary

- Public fork pull requests run only on GitHub-hosted machines. The optional
  local Docker runner has no default labels and a manual-main-only workflow;
  its immutable pre-job hook rejects other events/repositories/refs/revisions.
  Do not approve untrusted workflow changes for that runner. Public-repository
  self-hosted-runner risks are not eliminated merely by labels or containers.
- The user-designated repository PAT requests only a short-lived registration
  token; it is never passed into the runner, command arguments or logs. The
  ephemeral runner removes registration credentials after its one job. No host
  home, credential store or Docker socket is mounted; root is read-only with
  non-root UID, no capabilities, no-new-privileges and bounded CPU/memory/PIDs.
- An unavailable Docker user namespace remains an explicit failed isolation
  evidence gate. No privileged mode, host security switch or skipped-test pass
  is permitted to produce a green result. The narrow bwrap AppArmor allowance
  applies only to disposable hosted Ubuntu CI machines, not owner hosts.
- Windows remains NOT_QUALIFIED while POSIX permissions/path/socket/process
  assumptions fail. CI infrastructure delivery does not claim owner-only Windows
  ACLs, cross-platform containment or full release readiness.
