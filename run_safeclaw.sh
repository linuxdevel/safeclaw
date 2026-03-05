#!/usr/bin/env bash
# Run SafeClaw locally from the repo without installing globally.
# Usage: ./run_safeclaw.sh [command] [options]
#   e.g. ./run_safeclaw.sh chat
#        ./run_safeclaw.sh onboard
#        ./run_safeclaw.sh serve

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build if dist is missing or sources are newer
CLI_DIST="$REPO_DIR/packages/cli/dist/cli.js"
if [ ! -f "$CLI_DIST" ]; then
  echo "Building SafeClaw..." >&2
  pnpm --dir "$REPO_DIR" build
fi

exec node "$CLI_DIST" "$@"
