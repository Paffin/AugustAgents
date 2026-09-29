# Ephemeral GitHub runner for AugustAgents

This is an optional Linux ARM64 runner for **Paffin/AugustAgents**, not an app
deployment. The hosted Ubuntu/macOS/Windows matrix remains independent. No
registration or successful Actions job is established by merely building this
image. Docker's normal seccomp restrictions may prevent bubblewrap namespaces;
the evidence report fails rather than treating skipped security tests as passing.

The public-repository [self-hosted runner risk](https://docs.github.com/en/actions/reference/security/secure-use)
still applies. Do not approve untrusted workflow changes for this runner. It has
no default labels, serves one job, and runs an immutable pre-job hook refusing
anything except manual dispatch for this repository's main branch at the exact
owner-approved SHA. `local-runner.yml` has no pull-request or push trigger.

Build from the tracked `docker/github-runner` directory only:

```sh
docker --context desktop-linux build -t august-github-runner:2.337.0-arm64 docker/github-runner
```

The base image digest and runner archive SHA-256 are pinned. Runner 2.337.0 comes
from [the official release](https://github.com/actions/runner/releases/tag/v2.337.0).
This recipe supports Linux ARM64; it is not Windows or native macOS qualification.

Register only when ready to run the reviewed main revision. Use GitHub repository
Settings → Actions → Runners → New self-hosted runner → Linux ARM64 to obtain the
[short-lived registration token](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners).
Save only that token in an owner-only regular file outside the repository with
mode 0600; never paste it into a chat, shell command, environment file or Git.
Pass its **path**, not its value:

```sh
python3 docker/github-runner/launch.py --token-file /absolute/private/registration-token \
  --revision APPROVED_40_CHARACTER_MAIN_SHA --name august-runner-owner-job
```

The launcher passes the token through stdin, not Docker configuration or argv.
Registration uses the official runner's secret input environment in memory;
that environment is removed before listening for a job. Failed registration
diagnostics are withheld instead of possibly exposing credentials. The runner's
temporary registration credentials exist only in the container's private tmpfs.
No user home, repository, Docker socket or host credential directory is mounted.
The non-root container has a read-only root, no capabilities, no-new-privileges,
finite CPU/memory/PID limits and no published ports. It exits/removes after one job.

Dispatch `Approved main on local Docker runner` on **main** once the runner is
connected. Inspect the Actions log/artifact and exact SHA; an online runner or
green fake-adapter test alone is not useful live product acceptance. Do not
disable host AppArmor/seccomp or enable privileged mode to obtain a green result.
To stop this exact owned runner, use `docker --context desktop-linux stop
august-runner-owner-job`; do not run Docker prune or stop unrelated containers.
