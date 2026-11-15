# Eris worker: Claude Code in a container, as a non-root user (AGENTS.md §7: --dangerously-skip-permissions refuses root).
# Build with scripts/build-worker.sh (it passes your UID/GID so files the worker writes in demo-repo/ are yours).
FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.316
ARG WORKER_UID=1000
ARG WORKER_GID=1000

# git for the worker's local commits, python + pytest for the demo repo, procps for pkill/pgrep/ps (the harness
# interrupts runs from inside the container).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-pytest procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# The base image already has a `node` user and group at 1000:1000. A host UID/GID of 1000 would make useradd/groupadd
# fail, so reuse (rename) whatever already owns that id, and create the rest. Never root.
RUN set -eu; \
    [ "${WORKER_UID}" -ne 0 ] && [ "${WORKER_GID}" -ne 0 ] || { echo "refusing to build a root worker" >&2; exit 1; }; \
    if getent group "${WORKER_GID}" >/dev/null; then \
        g="$(getent group "${WORKER_GID}" | cut -d: -f1)"; \
        [ "$g" = worker ] || groupmod -n worker "$g"; \
    else \
        groupadd -g "${WORKER_GID}" worker; \
    fi; \
    if getent passwd "${WORKER_UID}" >/dev/null; then \
        u="$(getent passwd "${WORKER_UID}" | cut -d: -f1)"; \
        [ "$u" = worker ] || usermod -l worker -d /home/worker -m -g worker "$u"; \
    else \
        useradd -m -d /home/worker -u "${WORKER_UID}" -g worker -s /bin/bash worker; \
    fi; \
    if id node >/dev/null 2>&1; then userdel -r node 2>/dev/null || true; fi; \
    if getent group node >/dev/null; then groupdel node 2>/dev/null || true; fi; \
    mkdir -p /home/worker/.claude /workspace; \
    chown -R "${WORKER_UID}:${WORKER_GID}" /home/worker /workspace; \
    id worker

USER worker
ENV HOME=/home/worker \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1
WORKDIR /workspace

# Commits are local only: the worker has no remote and no credentials (AGENTS.md §7, §8).
RUN git config --global user.name "Eris Worker" \
 && git config --global user.email "worker@eris.invalid" \
 && git config --global --add safe.directory /workspace

# The harness keeps one long-lived container per agent and `docker exec`s `claude -p …` into it.
CMD ["sleep", "infinity"]
