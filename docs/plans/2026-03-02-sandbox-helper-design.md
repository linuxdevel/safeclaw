# Sandbox Helper Design — `safeclaw-sandbox-helper`

## Scope

Plan 6 covers the C binary, build system, CI/release workflows, and install script
updates. The Node.js integration layer (helper discovery, integrity checking, policy
serialization, graceful degradation in `Sandbox.execute()`) is deferred to a follow-up
plan.

## Approach

Bottom-up modules: build each C module independently with its own tests, then wire
them together via `main.c`. This maps to the spec's clean module boundaries and
produces small, reviewable tasks.

## Distribution

- Static binary built with `musl-gcc` (`-static`, musl libc)
- Per-architecture binaries attached as GitHub Release assets
- `SHA256SUMS` file generated during release for integrity verification
- Install script downloads the correct binary for the platform

---

## Project Structure

```
native/
├── Makefile
├── src/
│   ├── main.c           — arg parsing, orchestration, self-checks, fd hygiene, exec
│   ├── policy.c         — JSON parser, policy struct construction
│   ├── policy.h         — policy types and API
│   ├── landlock.c       — Landlock ruleset construction (ABI v1-v3)
│   ├── landlock.h
│   ├── seccomp.c        — BPF filter generation from syscall allowlist
│   ├── seccomp.h
│   ├── caps.c           — Capability dropping via capset()
│   ├── caps.h
│   └── syscall_table.h  — x86_64 syscall name→number lookup table
├── test/
│   ├── run-tests.sh     — test runner (exits non-zero on failure)
│   ├── test-policy.sh   — JSON parsing tests
│   ├── test-seccomp.sh  — BPF filter tests
│   ├── test-landlock.sh — Landlock tests (skipped if LSM not loaded)
│   ├── test-caps.sh     — Capability drop tests
│   └── test-integration.sh — End-to-end tests
└── SHA256SUMS           — generated during release build
```

---

## Module Designs

### policy.c — JSON Policy Parser

Minimal embedded JSON parser. No external dependencies.

- Supported types: objects, arrays, strings, booleans. No numbers.
- Input limit: 64 KiB max policy size.
- Reads from fd 3 (default) or `--policy-file` (fallback, requires mode 0600 + uid match).

Output struct:

```c
typedef struct {
    char path[PATH_MAX];
    int access;  // ACCESS_READ=1, ACCESS_WRITE=2, ACCESS_READWRITE=3, ACCESS_EXECUTE=4
} FsRule;

typedef struct {
    FsRule allow[64];       // max 64 allow rules
    int allow_count;
    FsRule deny[16];        // max 16 deny rules (for logging only)
    int deny_count;
    char syscalls[256][32]; // max 256 syscall names
    int syscall_count;
    int default_deny;       // from syscalls.defaultDeny
} Policy;
```

Error handling: returns error code + message. Does not abort.

### syscall_table.h — Syscall Name Lookup

Static table mapping names to x86_64 numbers using `__NR_*` constants from
`<sys/syscall.h>`. Linear scan lookup (called once during setup). Unknown names
cause exit code 72.

### seccomp.c — BPF Filter Construction

Converts syscall allowlist to classic BPF program:

1. Load + check `AUDIT_ARCH_X86_64`
2. Load syscall number
3. JEQ chain for each allowed syscall → ALLOW
4. Default: `SECCOMP_RET_KILL_PROCESS`

API: `int install_seccomp_filter(const Policy *policy)`.
Assumes `PR_SET_NO_NEW_PRIVS` already set by caller.

### landlock.c — Landlock Ruleset Construction

- Probes ABI version via `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`
- Builds `handled_access_fs` mask for detected ABI (v1/v2/v3)
- Maps JSON access strings to Landlock rights:
  - `read` → `READ_FILE`, `READ_DIR`
  - `write` → `WRITE_FILE`, `READ_FILE`, `READ_DIR`, `REMOVE_FILE`, `REMOVE_DIR`, `MAKE_REG`, `MAKE_DIR`, `MAKE_SYM`, `TRUNCATE` (v3+), `REFER` (v2+)
  - `readwrite` → all of read + write
  - `execute` → `EXECUTE`, `READ_FILE`
- Uses inline `syscall()` wrappers since musl may lack landlock functions
- Graceful degradation: returns distinct code for "unsupported" vs "error"

API: `int apply_landlock(const Policy *policy)`.

### caps.c — Capability Dropping

Zeroes effective, permitted, and inheritable capability sets via `capset()` with
`_LINUX_CAPABILITY_VERSION_3`.

API: `int drop_capabilities(void)`.

### main.c — Entry Point

Argument parsing: `safeclaw-sandbox-helper [--policy-file PATH] -- command [args...]`

Self-checks:
1. Refuse setuid/setgid (exit 76)
2. Verify x86_64 architecture (exit 76)

Execution sequence:
1. Parse args
2. Read + parse policy from fd 3 or file
3. Close fd 3
4. Open all path fds for Landlock (`O_PATH | O_CLOEXEC`)
5. `prctl(PR_SET_NO_NEW_PRIVS, 1)`
6. Apply Landlock (skip with warning if unsupported)
7. Close Landlock path fds
8. Install seccomp filter
9. Drop capabilities
10. Close all fds > 2
11. `execvp(command, args)`

Fail-closed: any setup failure exits immediately without exec.

Landlock graceful degradation: if `apply_landlock()` returns "unsupported" (not
"error"), print a warning to stderr and continue with seccomp + caps.

---

## CI & Release

### CI workflow (`.github/workflows/ci.yml`)

New `build-native` job (parallel with existing `build-and-test`):
- `ubuntu-latest`, install `musl-tools`
- `make -C native` to compile
- `make -C native check` to run tests

### Release workflow (`.github/workflows/release.yml`)

New `build-native` job before release:
- Build static binary with `musl-gcc`
- Generate `SHA256SUMS`
- Upload `safeclaw-sandbox-helper-linux-x86_64` and `SHA256SUMS` as release assets

### Install script (`install.sh`)

After downloading the main tarball:
- Download `safeclaw-sandbox-helper-linux-${RAW_ARCH}` from same release
- Verify SHA-256 checksum
- Place at `$INSTALL_DIR/bin/safeclaw-sandbox-helper` (mode 0755)
- Warn and continue if binary unavailable for platform

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 70   | Policy parse error |
| 71   | Landlock setup failed |
| 72   | Seccomp setup failed |
| 73   | Capability drop failed |
| 74   | Exec failed |
| 75   | Policy file permission check failed |
| 76   | Architecture not supported / setuid detected |
