#!/usr/bin/env bash
# Resets the demo to its starting state before a rehearsal (AGENTS.md §5.3 refers to this script):
#   - deletes the dev database (harness/data/eris.db + -wal/-shm), so test calls do not show up in recaps
#   - rebuilds demo-repo/ from demo-template/ (one commit, one failing test)
#   - removes the worker containers (eris-agent-N) and their home volumes, so old Claude sessions are gone
# Then restart the harness: it re-seeds on an empty database. Refuses to run while the harness is answering.
# Usage: scripts/seed-demo.sh [--yes]
# Overridable for tests: ERIS_DB_PATH, DEMO_REPO (relative to harness/, like the harness), HARNESS_URL, DOCKER.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db="${ERIS_DB_PATH:-$root/harness/data/eris.db}"
repo="${DEMO_REPO:-$root/demo-repo}"
[[ "$repo" = /* ]] || repo="$root/harness/$repo"
url="${HARNESS_URL:-http://localhost:8787}"
docker_cmd="${DOCKER:-docker}"

yes=0
case "${1:-}" in
  --yes|-y) yes=1 ;;
  "") ;;
  *) echo "usage: scripts/seed-demo.sh [--yes]" >&2; exit 2 ;;
esac

if command -v curl >/dev/null 2>&1 && curl -s -o /dev/null --max-time 2 "$url/agents"; then
  echo "seed-demo: the harness is running at $url. Stop it first (it would keep writing to the old database)." >&2
  exit 1
fi

have_docker=0
containers=() volumes=()
if command -v "$docker_cmd" >/dev/null 2>&1; then
  have_docker=1
  while IFS= read -r name; do [[ "$name" =~ ^eris-agent-[0-9]+$ ]] && containers+=("$name"); done \
    < <("$docker_cmd" ps -a --filter label=eris.agent --format '{{.Names}}' 2>/dev/null || true)
  while IFS= read -r name; do [[ "$name" =~ ^eris-agent-[0-9]+-home$ ]] && volumes+=("$name"); done \
    < <("$docker_cmd" volume ls -q 2>/dev/null || true)
fi

echo "This will:"
echo "  - delete the database $db (and its -wal/-shm files)"
echo "  - rebuild $repo and its agent clones from demo-template/ (anything in them is lost)"
if [[ $have_docker -eq 1 ]]; then
  echo "  - remove containers: ${containers[*]:-none}"
  echo "  - remove volumes:    ${volumes[*]:-none}"
else
  echo "  - (docker not found: no containers or volumes to remove)"
fi
if [[ $yes -ne 1 ]]; then
  read -r -p "Continue? [y/N] " answer || answer=""
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "aborted, nothing changed"; exit 1; }
fi

rm -f "$db" "$db-wal" "$db-shm"
"$root/scripts/make-demo-repo.sh" --force "$repo"
if [[ $have_docker -eq 1 ]]; then
  for name in "${containers[@]}"; do "$docker_cmd" rm -f "$name" >/dev/null; done
  for name in "${volumes[@]}"; do "$docker_cmd" volume rm "$name" >/dev/null; done
fi
echo "done. Start the harness again: it re-seeds on the empty database."
