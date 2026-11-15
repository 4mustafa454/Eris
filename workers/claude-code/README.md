# Claude Code worker image

One container per real agent (`eris-agent-1`, …), created by the harness (`harness/app/workers/docker.py`). The image
runs as a non-root `worker` user with your UID/GID, with Claude Code `2.1.316`, git, python3 and pytest. It has no
credentials: the API token is passed per run with `docker exec -e CLAUDE_CODE_OAUTH_TOKEN` and is never stored in the
image or the container.

```sh
scripts/build-worker.sh            # builds eris-claude-code:2.1.316 for your uid/gid
```

Only `demo-repo/` is mounted (at `/workspace`), plus a named volume for the agent's `~/.claude` so `--resume` survives a
container restart. No host home, no docker socket, all capabilities dropped. Workers commit locally and never push.

Upgrading Claude Code: change `CLAUDE_CODE_VERSION` in the Dockerfile and the default tag in `harness/app/config.py`
and `scripts/build-worker.sh` together (`harness/tests/test_dockerfile.py` checks they agree).
