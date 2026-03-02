#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
HELPER="$NATIVE_DIR/safeclaw-sandbox-helper"

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf "  PASS: %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  FAIL: %s\n" "$1"; }
skip() { SKIP=$((SKIP + 1)); printf "  SKIP: %s\n" "$1"; }

# Test: helper rejects missing -- separator
output=$("$HELPER" /bin/true 2>&1 || true)
if echo "$output" | grep -q "usage\|--"; then
    pass "rejects missing -- separator"
else
    fail "rejects missing -- separator"
fi

# Test: helper exits 70 on invalid policy via fd 3
rc=0
echo "not json" | "$HELPER" -- /bin/true 3<&0 2>/dev/null || rc=$?
if [ "$rc" -eq 70 ]; then
    pass "exits 70 on invalid policy"
else
    fail "exits 70 on invalid policy (got $rc)"
fi

# Test: helper exits 74 when command not found
# Note: writev needed because musl's fprintf uses writev internally
POLICY='{"filesystem":{"allow":[],"deny":[]},"syscalls":{"allow":["execve","exit_group","brk","mmap","mprotect","munmap","arch_prctl","set_tid_address","set_robust_list","rseq","prlimit64","getrandom","futex","read","write","writev","close","fstat","rt_sigaction","rt_sigprocmask","access","newfstatat","openat"],"defaultDeny":true}}'
rc=0
echo "$POLICY" | "$HELPER" -- /nonexistent/command 3<&0 2>/dev/null || rc=$?
if [ "$rc" -eq 74 ]; then
    pass "exits 74 when command not found"
else
    fail "exits 74 when command not found (got $rc)"
fi

# Test: helper successfully execs a command with valid policy
# Note: pread64 needed by glibc dynamic linker; writev by musl fprintf
POLICY='{"filesystem":{"allow":[{"path":"/","access":"read"},{"path":"/tmp","access":"readwrite"},{"path":"/usr","access":"execute"}],"deny":[]},"syscalls":{"allow":["execve","exit_group","brk","mmap","mprotect","munmap","arch_prctl","set_tid_address","set_robust_list","rseq","prlimit64","getrandom","futex","read","write","writev","close","fstat","pread64","rt_sigaction","rt_sigprocmask","access","newfstatat","openat","ioctl","getpid","uname","fcntl","getcwd","readlink","sysinfo","clone","wait4","rt_sigreturn","getuid","getgid","geteuid","getegid","sigaltstack","statfs","getdents64","lseek","dup2","pipe"],"defaultDeny":true}}'
output=$(echo "$POLICY" | "$HELPER" -- /bin/echo "hello sandbox" 3<&0 2>/dev/null) || true
if [ "$output" = "hello sandbox" ]; then
    pass "successfully execs command with valid policy"
else
    fail "successfully execs command with valid policy (got: $output)"
fi

# Test: helper reads policy from --policy-file
TMPFILE=$(mktemp /tmp/safeclaw-test-XXXXXX.json)
chmod 600 "$TMPFILE"
echo "$POLICY" > "$TMPFILE"
output=$("$HELPER" --policy-file "$TMPFILE" -- /bin/echo "from file" 2>/dev/null) || true
rm -f "$TMPFILE"
if [ "$output" = "from file" ]; then
    pass "reads policy from --policy-file"
else
    fail "reads policy from --policy-file (got: $output)"
fi

# Test: helper rejects policy file with wrong permissions
TMPFILE=$(mktemp /tmp/safeclaw-test-XXXXXX.json)
chmod 644 "$TMPFILE"
echo "$POLICY" > "$TMPFILE"
rc=0
"$HELPER" --policy-file "$TMPFILE" -- /bin/true 2>/dev/null || rc=$?
rm -f "$TMPFILE"
if [ "$rc" -eq 75 ]; then
    pass "rejects policy file with wrong permissions"
else
    fail "rejects policy file with wrong permissions (got $rc)"
fi

# Test: setuid check (we can't actually test this without root, so skip)
skip "setuid/setgid detection (requires root to test)"

echo ""
echo "--- integration: $PASS passed, $FAIL failed, $SKIP skipped ---"
[ "$FAIL" -eq 0 ]
