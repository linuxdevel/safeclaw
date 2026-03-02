#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
TEST_BIN="$SCRIPT_DIR/test-landlock"
if [ ! -x "$TEST_BIN" ]; then
    echo "  Building test-landlock..."
    make -C "$NATIVE_DIR" test-landlock
fi
"$TEST_BIN"
