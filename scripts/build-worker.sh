#!/usr/bin/env bash
# Builds the Claude Code worker image for your user: scripts/build-worker.sh [image-tag]
# The default tag matches harness/app/config.py (WORKER_IMAGE). Needs Docker.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:-eris-claude-code:2.1.316}"
exec docker build \
  --build-arg "WORKER_UID=$(id -u)" --build-arg "WORKER_GID=$(id -g)" \
  -t "$tag" "$root/workers/claude-code"
