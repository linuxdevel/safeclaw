#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
TEST_BIN="$SCRIPT_DIR/test-seccomp"
if [ ! -x "$TEST_BIN" ]; then
    echo "  Building test-seccomp..."
    make -C "$NATIVE_DIR" test-seccomp
fi
"$TEST_BIN"
