#!/usr/bin/env bash
# Install a locally chosen Pi version without modifying tracked files.
# package.json and bun.lock stay pinned; node_modules is local state only.
set -euo pipefail

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "usage: $0 <pi-version>   e.g. $0 0.82.0" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

bun add \
  "@earendil-works/pi-agent-core@${version}" \
  "@earendil-works/pi-ai@${version}" \
  --no-save

echo
echo "Installed Pi ${version} locally (package.json / bun.lock unchanged)."
echo "Restore the pinned version with: bun install --frozen-lockfile"
