#!/bin/sh
# Immutable pre-job hook: fail before checkout/steps for anything except approved main.
set -eu
test "${GITHUB_EVENT_NAME:-}" = workflow_dispatch
test "${GITHUB_REPOSITORY:-}" = Paffin/AugustAgents
test "${GITHUB_REF:-}" = refs/heads/main
test "${GITHUB_SHA:-}" = "$(cat /runner/approved-revision)"
