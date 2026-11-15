#!/usr/bin/env bash
# Build the Codex worker for the host UID/GID. Needs Docker.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:-eris-codex:0.114.0}"
exec docker build \
  --build-arg "WORKER_UID=$(id -u)" --build-arg "WORKER_GID=$(id -g)" \
  -t "$tag" "$root/workers/codex"
