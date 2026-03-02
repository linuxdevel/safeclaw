#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
HELPER="$NATIVE_DIR/safeclaw-sandbox-helper"

if [ ! -x "$HELPER" ]; then
    echo "ERROR: $HELPER not found or not executable. Run 'make test-bins' first."
    exit 1
fi

echo "=== safeclaw-sandbox-helper test suite ==="
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
SUITE_FAIL=0

for test_script in "$SCRIPT_DIR"/test-*.sh; do
    [ -f "$test_script" ] || continue
    name="$(basename "$test_script")"
    echo "--- $name ---"

    # Run the test script, capture output and exit code
    set +e
    output=$(bash "$test_script" "$HELPER" 2>&1)
    rc=$?
    set -e

    echo "$output"
    echo ""

    # Count PASS/FAIL/SKIP lines from the output
    pass_count=$(echo "$output" | grep -c "PASS:" || true)
    fail_count=$(echo "$output" | grep -c "FAIL:" || true)
    skip_count=$(echo "$output" | grep -c "SKIP:" || true)

    TOTAL_PASS=$((TOTAL_PASS + pass_count))
    TOTAL_FAIL=$((TOTAL_FAIL + fail_count))
    TOTAL_SKIP=$((TOTAL_SKIP + skip_count))

    if [ "$rc" -ne 0 ]; then
        SUITE_FAIL=1
    fi
done

echo "=== Results: $TOTAL_PASS passed, $TOTAL_FAIL failed, $TOTAL_SKIP skipped ==="

if [ "$TOTAL_FAIL" -gt 0 ] || [ "$SUITE_FAIL" -ne 0 ]; then
    exit 1
fi
