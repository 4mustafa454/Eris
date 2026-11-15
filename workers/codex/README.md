# Codex worker image

`scripts/build-codex-worker.sh` builds the pinned Codex image for the host UID/GID. The worker runs as a non-root user with git, Python, pytest and procps. The image contains no credentials.

The harness runs it for agents listed in `REAL_WORKERS` whose engine is `codex` (agent-3 by default). The host's `~/.codex/auth.json` is mounted
read-only, so refresh the token on the host before a demo; see `docs/DEMO.md`.
