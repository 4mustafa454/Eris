# Codex worker image

`scripts/build-codex-worker.sh` builds the pinned Codex image for the host UID/GID. The worker runs as a non-root user with git, Python, pytest and procps. The image contains no credentials.

The harness integration, worktree mount and read-only host authentication mount are subsequent M4 steps. The image and Codex version require a Docker build and smoke test before use.
