#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
TEST_BIN="$SCRIPT_DIR/test-caps"

if [ ! -x "$TEST_BIN" ]; then
    echo "  Building test-caps..."
    make -C "$NATIVE_DIR" test-caps
fi

"$TEST_BIN"
