# Sandbox Helper Specification — `safeclaw-sandbox-helper`

## Purpose

Node.js cannot directly invoke the system calls required for kernel-level sandboxing:

- `landlock_create_ruleset(2)`, `landlock_add_rule(2)`, `landlock_restrict_self(2)` — filesystem ACLs
- `prctl(PR_SET_SECCOMP)` / `seccomp(2)` — syscall filtering via BPF
- `prctl(PR_SET_NO_NEW_PRIVS)` — required before seccomp
- `capset(2)` — capability dropping

There are no stable, maintained Node.js bindings for these APIs. `node-ffi-napi` introduces a large attack surface and is unsuitable for security-critical code. A compiled C helper is the standard approach (used by Bubblewrap, Firejail, nsjail, etc.).

`safeclaw-sandbox-helper` is a small, statically-linked C binary that:
1. Reads a JSON policy from a file descriptor
2. Applies Landlock filesystem restrictions
3. Installs a seccomp-BPF syscall filter
4. Drops all Linux capabilities
5. `exec`s the target command

The Node.js `Sandbox.execute()` spawns this helper instead of calling `unshare` directly. Namespace isolation (PID, NET, MNT, USER) is still handled by `unshare(1)` since it doesn't require custom code — the helper runs *inside* the already-created namespaces.

---

## Input Format

The helper receives its policy via **file descriptor 3** (default) or via a `--policy-file` flag pointing to a path. The fd approach avoids writing policy to disk and is the preferred method.

### Spawn pattern (Node.js side)

```typescript
const policyJson = JSON.stringify(policy);

// Open a pipe on fd 3 for the child
const proc = spawn("unshare", [
  ...unshareFlags,
  "--",
  "safeclaw-sandbox-helper",
  "--",
  command,
  ...args,
], {
  stdio: ["ignore", "pipe", "pipe", "pipe"],  // fd 0-3
});

// Write policy JSON to fd 3, then close it
proc.stdio[3].end(policyJson);
```

### Fallback: `--policy-file`

```
safeclaw-sandbox-helper --policy-file /tmp/safeclaw-policy-XXXXXX.json -- /usr/bin/python3 script.py
```

Used only when fd 3 is not available (debugging, manual invocation). The file must be mode `0600` and owned by the current user; the helper verifies this before reading.

### JSON Policy Schema

```json
{
  "filesystem": {
    "allow": [
      { "path": "/usr/lib", "access": "read" },
      { "path": "/tmp/workdir", "access": "readwrite" },
      { "path": "/usr/bin/python3", "access": "execute" }
    ],
    "deny": [
      { "path": "/etc/shadow", "access": "read" }
    ]
  },
  "syscalls": {
    "allow": [
      "read", "write", "exit", "exit_group", "brk", "mmap",
      "close", "fstat", "mprotect", "munmap", "rt_sigaction",
      "rt_sigprocmask", "ioctl", "access", "getpid", "clone",
      "execve", "wait4", "uname", "fcntl", "getcwd",
      "arch_prctl", "set_tid_address", "set_robust_list",
      "rseq", "prlimit64", "getrandom"
    ],
    "defaultDeny": true
  }
}
```

The schema matches the `SandboxPolicy.filesystem` and `SandboxPolicy.syscalls` fields from `packages/sandbox/src/types.ts`. The `network` and `namespaces` fields are not included — those are handled by `unshare` before the helper runs.

---

## Landlock ABI Versions

The helper detects the Landlock ABI version at runtime via `landlock_create_ruleset(2)` with a zero-length ruleset (the documented probe method).

### ABI v1 (kernel 5.13+)

Filesystem access rights:
- `LANDLOCK_ACCESS_FS_EXECUTE`
- `LANDLOCK_ACCESS_FS_WRITE_FILE`
- `LANDLOCK_ACCESS_FS_READ_FILE`
- `LANDLOCK_ACCESS_FS_READ_DIR`
- `LANDLOCK_ACCESS_FS_REMOVE_DIR`
- `LANDLOCK_ACCESS_FS_REMOVE_FILE`
- `LANDLOCK_ACCESS_FS_MAKE_CHAR`
- `LANDLOCK_ACCESS_FS_MAKE_DIR`
- `LANDLOCK_ACCESS_FS_MAKE_REG`
- `LANDLOCK_ACCESS_FS_MAKE_SOCK`
- `LANDLOCK_ACCESS_FS_MAKE_FIFO`
- `LANDLOCK_ACCESS_FS_MAKE_BLOCK`
- `LANDLOCK_ACCESS_FS_MAKE_SYM`

### ABI v2 (kernel 5.19+)

Adds:
- `LANDLOCK_ACCESS_FS_REFER` — controls cross-directory renames and links

### ABI v3 (kernel 6.2+)

Adds:
- `LANDLOCK_ACCESS_FS_TRUNCATE` — controls file truncation

### Access mapping

The JSON `access` field maps to Landlock rights as follows:

| JSON `access` | Landlock rights granted |
|---|---|
| `"read"` | `READ_FILE`, `READ_DIR` |
| `"write"` | `WRITE_FILE`, `READ_FILE`, `READ_DIR`, `REMOVE_FILE`, `REMOVE_DIR`, `MAKE_REG`, `MAKE_DIR`, `MAKE_SYM`, `TRUNCATE` (v3+), `REFER` (v2+) |
| `"readwrite"` | All of `"read"` + `"write"` |
| `"execute"` | `EXECUTE`, `READ_FILE` |

The helper creates a ruleset that **handles all** rights supported by the detected ABI version. Rights not explicitly granted by any allow rule are denied. This is the Landlock best-effort model: the helper always restricts to the maximum extent the kernel supports.

### Setup sequence

```c
// 1. Probe ABI version
int abi = landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);

// 2. Build handled_access_fs mask for detected ABI
__u64 handled = LANDLOCK_ACCESS_FS_EXECUTE | ... ; // all rights for ABI version

// 3. Create ruleset
struct landlock_ruleset_attr attr = { .handled_access_fs = handled };
int ruleset_fd = landlock_create_ruleset(&attr, sizeof(attr), 0);

// 4. Add rules for each allow entry
for each allow_rule in policy.filesystem.allow:
    struct landlock_path_beneath_attr path_attr = {
        .allowed_access = map_access(allow_rule.access, abi),
        .parent_fd = open(allow_rule.path, O_PATH | O_CLOEXEC),
    };
    landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0);

// 5. Enforce
prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);  // required before restrict_self
landlock_restrict_self(ruleset_fd, 0);
close(ruleset_fd);
```

Deny rules are implicit: any path not explicitly allowed is denied by the ruleset. The `deny` array in the JSON policy is for documentation and for the Node.js layer to log warnings — the Landlock model is allowlist-only.

---

## Seccomp-BPF Filter Construction

The helper converts the syscall allowlist into a classic BPF program loaded via `seccomp(SECCOMP_SET_MODE_FILTER)`.

### BPF program structure

```
[0] BPF_LD | BPF_W | BPF_ABS    — load syscall number (offsetof(seccomp_data, nr))
[1] BPF_JMP | BPF_JEQ  nr=__NR_read   → ALLOW
[2] BPF_JMP | BPF_JEQ  nr=__NR_write  → ALLOW
...
[N] BPF_JMP | BPF_JEQ  nr=__NR_last   → ALLOW
[N+1] BPF_RET | SECCOMP_RET_KILL_PROCESS     — default: kill
[N+2] BPF_RET | SECCOMP_RET_ALLOW            — ALLOW target
```

### Architecture handling

The filter checks `seccomp_data.arch` first to prevent syscall number confusion across architectures:

```c
// Reject if not x86_64
BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
```

### Syscall name resolution

Syscall names from the JSON are resolved to numbers at compile time using a lookup table generated from `<sys/syscall.h>`. The helper supports x86_64 only in v1. Unknown syscall names cause the helper to exit with an error before `exec`.

### Default action

`SECCOMP_RET_KILL_PROCESS` — kills the entire thread group on a denied syscall. This is preferred over `SECCOMP_RET_KILL_THREAD` which only kills the offending thread and can leave the process in a broken state.

### Filter installation

```c
prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);  // already set by Landlock step
struct sock_fprog prog = { .len = count, .filter = instructions };
seccomp(SECCOMP_SET_MODE_FILTER, 0, &prog);
```

---

## Capability Dropping Sequence

The order of operations is critical. Some setup steps require capabilities that later steps remove. The sequence:

```
1. Read and parse JSON policy from fd 3
2. Close fd 3
3. Open all path file descriptors needed for Landlock rules
4. prctl(PR_SET_NO_NEW_PRIVS, 1)     — point of no return for privileges
5. Apply Landlock ruleset              — restricts filesystem
6. Close all Landlock path fds
7. Install seccomp-BPF filter          — restricts syscalls
8. Drop all capabilities               — capset() to zero all sets
9. execvp(command, args)               — replace process image
```

Key ordering constraints:
- **Step 3 before step 5**: Landlock rule creation needs `open()` on the target paths; after `landlock_restrict_self`, those opens might be denied.
- **Step 4 before step 5 and 7**: Both Landlock and seccomp require `PR_SET_NO_NEW_PRIVS`.
- **Step 5 before step 7**: Landlock setup uses syscalls (e.g., `landlock_create_ruleset`) that the seccomp filter will deny.
- **Step 7 before step 8**: `seccomp()` may require `CAP_SYS_ADMIN` in some configurations. Drop caps after.
- **Step 8 before step 9**: Ensure the exec'd process inherits zero capabilities.

### Capability dropping implementation

```c
struct __user_cap_header_struct hdr = {
    .version = _LINUX_CAPABILITY_VERSION_3,
    .pid = 0,  // current process
};
struct __user_cap_data_struct data[2] = {};  // zeroed = no capabilities
capset(&hdr, data);
```

This clears the effective, permitted, and inheritable capability sets. Combined with `PR_SET_NO_NEW_PRIVS`, the exec'd process cannot gain any capabilities.

---

## Error Handling

The helper follows a **fail-closed** model: if any setup step fails, the process exits immediately without exec'ing the target.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | (not used by helper; only the exec'd process returns 0) |
| 70 | Policy parse error (invalid JSON, missing fields) |
| 71 | Landlock setup failed (unsupported kernel, bad path) |
| 72 | Seccomp setup failed (unknown syscall name, BPF load error) |
| 73 | Capability drop failed |
| 74 | Exec failed (command not found, permission denied) |
| 75 | Policy file permission check failed |
| 76 | Architecture not supported |

### Error output

All errors are written to **stderr** as a single line:

```
safeclaw-sandbox-helper: error: landlock_create_ruleset failed: Operation not permitted (errno=1)
```

The Node.js side captures stderr and includes it in the `SandboxResult.stderr` field.

### Signal handling

The helper does not install signal handlers. It inherits the default signal disposition. If killed by a signal before exec, the parent `Sandbox.execute()` sees the signal-based exit code and reports accordingly.

---

## Build System

### Makefile

```makefile
CC      ?= musl-gcc
CFLAGS  := -std=c11 -Wall -Wextra -Werror -pedantic -O2 \
           -D_GNU_SOURCE -static
LDFLAGS := -static

PREFIX  ?= /usr/local
BINDIR  := $(PREFIX)/bin

SRC     := src/main.c src/landlock.c src/seccomp.c src/policy.c src/caps.c
OBJ     := $(SRC:.c=.o)
BIN     := safeclaw-sandbox-helper

.PHONY: all clean install check

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(LDFLAGS) -o $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJ) $(BIN)

install: $(BIN)
	install -Dm755 $(BIN) $(DESTDIR)$(BINDIR)/$(BIN)

check: $(BIN)
	./test/run-tests.sh
```

### Source file layout

```
native/
├── Makefile
├── src/
│   ├── main.c       — argument parsing, orchestration, exec
│   ├── policy.c     — JSON parsing (minimal, no external deps)
│   ├── policy.h
│   ├── landlock.c   — Landlock ruleset construction
│   ├── landlock.h
│   ├── seccomp.c    — BPF filter generation
│   ├── seccomp.h
│   ├── caps.c       — Capability dropping
│   ├── caps.h
│   └── syscall_table.h  — x86_64 syscall name→number mapping
├── test/
│   ├── run-tests.sh
│   ├── test-landlock.sh
│   ├── test-seccomp.sh
│   └── test-caps.sh
└── SHA256SUMS
```

### Static linking

The binary is statically linked with musl libc for portability across Linux distributions. This eliminates glibc version dependencies. The binary has no runtime dependencies other than the Linux kernel.

### JSON parsing

The helper uses a minimal embedded JSON parser (< 500 lines). No external dependencies. Only the subset of JSON needed for the policy schema is supported: objects, arrays, strings, booleans. Numbers are not needed.

### Cross-compilation

For CI, the Makefile supports cross-compilation via:

```bash
CC=x86_64-linux-musl-gcc make
```

---

## Integration with Sandbox.execute()

The Node.js side changes from:

```typescript
// Current: unshare only
spawn("unshare", [...unshareFlags, "--", command, ...args]);
```

To:

```typescript
// With helper: unshare + helper
spawn("unshare", [
  ...unshareFlags,
  "--",
  "safeclaw-sandbox-helper",
  "--",
  command,
  ...args,
], {
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});
```

### Helper discovery

`Sandbox.execute()` looks for the helper in this order:

1. `SAFECLAW_HELPER_PATH` environment variable
2. `path.join(__dirname, '..', '..', 'native', 'safeclaw-sandbox-helper')` — co-located in the package
3. `which safeclaw-sandbox-helper` — system PATH

If the helper is not found, `Sandbox.execute()` falls back to `unshare`-only mode and logs a warning that Landlock and seccomp are not active. The `SandboxResult` should include metadata indicating which enforcement layers were applied.

### Helper integrity check

Before spawning the helper, the Node.js side verifies its SHA-256 checksum against a known-good value embedded in the `@safeclaw/sandbox` package:

```typescript
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const KNOWN_HASH = "sha256:abcdef1234..."; // embedded at build time

function verifyHelper(helperPath: string): boolean {
  const binary = readFileSync(helperPath);
  const hash = createHash("sha256").update(binary).digest("hex");
  return `sha256:${hash}` === KNOWN_HASH;
}
```

If verification fails, the helper is not used. This prevents a compromised helper binary from being used as a privilege escalation vector.

### Graceful degradation

| Helper available | Enforcement layers |
|---|---|
| Yes, checksum valid | Namespaces + Landlock + seccomp + cap drop |
| Yes, checksum invalid | Namespaces only (warning logged) |
| No | Namespaces only (warning logged) |

---

## Security Considerations

### Why the helper must be integrity-checked

The helper runs with the same privileges as the Node.js process. A tampered helper could:
- Skip sandbox setup and exec the target unrestricted
- Exfiltrate the policy JSON (which reveals allowed paths and syscalls)
- Replace the target command with a malicious payload

The SHA-256 checksum embedded in the npm package ensures the binary matches what was built in CI. The checksum is part of the published package, so npm's own integrity checking (via `package-lock.json` hashes) provides a chain of trust.

### Privilege escalation prevention

- `PR_SET_NO_NEW_PRIVS` is set before any sandbox enforcement. This is a one-way flag — once set, `exec` cannot gain privileges via setuid/setgid binaries.
- The helper does not run as root and does not require setuid. User namespaces provide the necessary privilege separation.
- The helper's own binary should NOT be setuid. If found to be setuid, it must exit with an error.

### Self-checks on startup

The helper performs these checks before any policy processing:

```c
// Refuse to run if setuid/setgid
if (getuid() != geteuid() || getgid() != getegid()) {
    fprintf(stderr, "safeclaw-sandbox-helper: error: refusing to run as setuid/setgid\n");
    exit(76);
}

// Refuse to run as PID 1 (indicates no PID namespace, or init role)
if (getpid() == 1 && getenv("SAFECLAW_ALLOW_PID1") == NULL) {
    // This is expected inside a PID namespace — but only if unshare --fork was used.
    // If we ARE PID 1, that's fine; we'll exec and the child becomes PID 1.
    // No action needed.
}
```

### Fd hygiene

Before exec, the helper closes all file descriptors except 0, 1, 2 (stdin/stdout/stderr). This prevents fd leakage from the Node.js parent process into the sandboxed child.

```c
// Close all fds > 2
int maxfd = sysconf(_SC_OPEN_MAX);
for (int fd = 3; fd < maxfd; fd++) {
    close(fd);  // ignore EBADF
}
```

### Memory safety

The helper is written in C11 with `-Wall -Wextra -Werror`. The JSON parser operates on a bounded-size input (policy JSON is limited to 64 KiB). Stack buffers use explicit size limits. The helper does not allocate heap memory after the initial policy parse — all further operations use stack or kernel-managed resources (file descriptors).

### Auditing

The helper is intentionally small (target: < 1500 lines of C across all source files). This makes it feasible to audit the entire codebase for security issues. The restricted feature set (parse JSON, make syscalls, exec) limits the attack surface.
