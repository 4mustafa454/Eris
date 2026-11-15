#!/usr/bin/env bash
# Dev only: create a pending approval (shows up in /approvals, /context and the /events SSE stream).
# Usage: scripts/seed-approval.sh <agent-id> "<action>" [--detail TEXT]
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/harness"
exec .venv/bin/python -m app.dev seed-approval "$@"
