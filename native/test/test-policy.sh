#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
TEST_BIN="$SCRIPT_DIR/test-policy"
if [ ! -x "$TEST_BIN" ]; then
    echo "  Building test-policy..."
    make -C "$NATIVE_DIR" test-policy
fi
"$TEST_BIN"
