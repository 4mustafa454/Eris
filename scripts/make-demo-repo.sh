#!/usr/bin/env bash
# Builds the demo repo the workers operate on: copies demo-template/ into a fresh git repo (default demo-repo/) with one
# commit. Never pushes, and the repo has no remote. Usage: scripts/make-demo-repo.sh [--force] [target-dir]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
force=0
if [[ "${1:-}" == "--force" ]]; then force=1; shift; fi
target="${1:-$root/demo-repo}"

if [[ -e "$target" ]]; then
  if [[ $force -ne 1 ]]; then
    echo "make-demo-repo: $target already exists (use --force to rebuild it, or scripts/seed-demo.sh)" >&2
    exit 1
  fi
  rm -rf "$target"
fi

mkdir -p "$target"
cp -r "$root/demo-template/." "$target/"
git -C "$target" init -q -b main
git -C "$target" -c user.name="Eris Demo" -c user.email="demo@eris.invalid" add -A
git -C "$target" -c user.name="Eris Demo" -c user.email="demo@eris.invalid" commit -q -m "Initial commit: shop demo with one failing test"
echo "demo repo ready: $target (1 commit, 1 failing test, no remote)"
