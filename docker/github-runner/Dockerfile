FROM node:26.0.0-bookworm-slim@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c
LABEL io.august.owner="github-runner" io.august.repository="Paffin/AugustAgents"
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 bubblewrap unzip libicu72 libssl3 libkrb5-3 zlib1g \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/actions-runner
RUN curl --fail --location --silent --show-error \
    https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-arm64-2.337.0.tar.gz \
    --output /tmp/runner.tar.gz \
    && echo '9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393  /tmp/runner.tar.gz' | sha256sum --check \
    && tar xzf /tmp/runner.tar.gz && rm /tmp/runner.tar.gz
COPY entrypoint.py guard.sh /opt/august-runner/
RUN chmod 0555 /opt/august-runner/guard.sh
USER 1000:1000
WORKDIR /runner
ENV HOME=/home/node ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/august-runner/guard.sh
ENTRYPOINT ["python3", "/opt/august-runner/entrypoint.py"]
