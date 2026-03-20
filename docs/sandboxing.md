# Sandboxing Deep Dive

SafeClaw enforces OS-level sandboxing on every tool execution. This document explains the architecture, threat model, enforcement layers, and security guarantees of the sandboxing system.

For a high-level overview of SafeClaw's security model (including capabilities, skill signing, and vault encryption), see [Security Model](security-model.md).

---

## Why sandbox?

AI coding agents execute arbitrary commands suggested by LLMs. Without containment, a single malicious or hallucinated tool call can:

- Read or exfiltrate sensitive files (`~/.ssh`, `~/.aws`, environment variables)
- Install persistent backdoors or reverse shells
- Modify source code to inject supply-chain payloads
- Access network services (databases, cloud metadata endpoints)
- Escalate privileges via setuid binaries or kernel exploits

SafeClaw treats every tool execution as untrusted. The sandbox limits the blast radius of any single execution to the permissions declared in the tool's capability manifest.

---

## Architecture

SafeClaw uses a two-layer sandbox. The outer layer (provided by `@anthropic-ai/sandbox-runtime`) creates a container using bubblewrap on Linux or sandbox-exec on macOS. The inner layer (the C helper binary) applies Landlock, seccomp-BPF, and capability dropping inside the container.

```
┌──────────────────────────────────────────────────────────────┐
│  Node.js: Sandbox.execute(command, args)                     │
│                                                              │
│  1. Resolve helper binary (discovery)                        │
│  2. Write policy JSON to temp file (mode 0o600)              │
│  3. Build inner command: helper --policy-file <tmp> -- cmd   │
│  4. Translate SandboxPolicy → SandboxRuntimeConfig           │
│     (PolicyBuilder.toRuntimeConfig)                          │
│  5. SandboxManager.wrapWithSandbox(innerCmd, rtConfig)       │
│  6. Spawn wrapped command via /bin/sh -c                     │
│  7. Collect stdout/stderr, enforce timeout                   │
│  8. Cleanup: delete temp policy file                         │
└──────────────────────┬───────────────────────────────────────┘
                       │ fork+exec
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  @anthropic-ai/sandbox-runtime (outer layer)                 │
│                                                              │
│  Linux (bubblewrap):                                         │
│  - pivot_root: new filesystem root with bind-mounted paths   │
│  - PID, network, mount, user namespaces                      │
│  - Network proxy (socat) for controlled domain access        │
│                                                              │
│  macOS (sandbox-exec):                                       │
│  - sandbox-exec profile restricts filesystem + network       │
└──────────────────────┬───────────────────────────────────────┘
                       │ exec
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  safeclaw-sandbox-helper (static C binary, ~800 KB)          │
│  (Linux only; skipped on macOS)                              │
│                                                              │
│  1. Self-checks (refuse setuid, PR_SET_NO_NEW_PRIVS)         │
│  2. Read policy JSON from --policy-file path                 │
│  3. Apply Landlock filesystem restrictions                   │
│  4. Close all fds > 2 (fd hygiene)                           │
│  5. Drop all Linux capabilities                              │
│  6. Install seccomp-BPF syscall filter                       │
│  7. exec(command, args)                                      │
└──────────────────────┬───────────────────────────────────────┘
                       │ exec
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Target command (e.g., /bin/bash -c "npm test")              │
│                                                              │
│  Runs with ALL restrictions active (Linux):                  │
│  - Filesystem: pivot_root container + Landlock path rules    │
│  - Syscalls: only allow-listed syscalls permitted            │
│  - Network: isolated via namespace + network proxy           │
│  - Capabilities: all dropped                                 │
│  - Privileges: cannot escalate (NO_NEW_PRIVS)                │
└──────────────────────────────────────────────────────────────┘
```

---

## Enforcement layers

### Layer 1: Container isolation (via `@anthropic-ai/sandbox-runtime`)

The outer layer uses `@anthropic-ai/sandbox-runtime` to create an isolated process container. The specific mechanism varies by platform:

**Linux (bubblewrap / bwrap):**

| Feature | Effect |
|---------|--------|
| `pivot_root` | New filesystem root; only bind-mounted paths are visible |
| PID namespace | Process sees only its own PID tree; cannot signal host processes |
| Network namespace | Fresh network stack; external connectivity controlled by network proxy |
| Mount namespace | Isolated mount table; filesystem changes don't affect host |
| User namespace | Unprivileged user mapping; enables other namespaces without root |
| Network proxy (socat) | Intercepts outbound connections; enforces `allowedDomains`/`deniedDomains` |

`PolicyBuilder.toRuntimeConfig()` translates a `SandboxPolicy` into a `SandboxRuntimeConfig`:
- `filesystem.allow` rules with `readwrite` or `readwriteexecute` access map to `allowWrite` (bind-mounted read-write)
- Sensitive credential directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, etc.) that exist as real directories (not symlinks) are added to `denyRead`; symlinks are excluded to avoid bwrap failures on WSL2
- Network policy maps to `allowedDomains`/`deniedDomains`

**macOS (sandbox-exec):**

The macOS `sandbox-exec` utility applies a Seatbelt profile that restricts filesystem access and network connectivity. Linux-specific layers (Landlock, seccomp-BPF, namespaces) are not available on macOS.

This is the baseline — it works even without the C helper binary.

### Layer 2: Landlock filesystem restrictions

[Landlock](https://docs.kernel.org/userspace-api/landlock.html) is a Linux security module (available since kernel 5.13) that restricts filesystem access for unprivileged processes.

The helper creates a Landlock ruleset and adds rules based on the policy's `filesystem.allow` list:

| Access type | Landlock permissions granted (directories) | Landlock permissions granted (files) |
|-------------|---------------------------------------------|--------------------------------------|
| `read` | `READ_FILE`, `READ_DIR` | `READ_FILE` |
| `write` | `WRITE_FILE`, `READ_FILE`, `READ_DIR`, `REMOVE_FILE`, `REMOVE_DIR`, `MAKE_REG`, `MAKE_DIR`, `MAKE_SYM` | `WRITE_FILE`, `READ_FILE` |
| `readwrite` | Both read and write permissions | `EXECUTE`, `WRITE_FILE`, `READ_FILE` |
| `execute` | `EXECUTE`, `READ_FILE` | `EXECUTE`, `READ_FILE` |

Any path not in the allow list is **denied by default**. The `filesystem.deny` list is reserved for future use (explicit deny rules for paths that might be granted by a parent allow rule).

**File vs directory path handling:** Landlock's `RULE_PATH_BENEATH` only permits a subset of access rights when the fd refers to a regular file. Directory-only rights (`READ_DIR`, `REMOVE_DIR`, `REMOVE_FILE`, `MAKE_*`, `REFER`) cause `EINVAL` on file fds. The helper detects file paths via `fstat()` and automatically strips directory-only rights, so policies can freely mix file and directory paths.

**ABI compatibility:** The helper detects the kernel's Landlock ABI version at runtime (v1-v3) and adjusts the handled access flags accordingly. If Landlock is not available, the helper prints a warning and continues -- SafeClaw falls back to namespace-only isolation.

### Layer 3: seccomp-BPF syscall filtering

[seccomp-BPF](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html) restricts which system calls a process can invoke. The helper constructs a BPF program that:

1. Validates the architecture is `AUDIT_ARCH_X86_64`
2. Allows each syscall in the policy's `syscalls.allow` list
3. Returns `SECCOMP_RET_KILL_PROCESS` for any syscall not in the allow list

The default policy allows 27 syscalls -- the minimum needed for basic process execution:

```
read, write, exit, exit_group, brk, mmap, close, fstat, mprotect,
munmap, rt_sigaction, rt_sigprocmask, ioctl, access, getpid, clone,
execve, wait4, uname, fcntl, getcwd, arch_prctl, set_tid_address,
set_robust_list, rseq, prlimit64, getrandom
```

Syscall name-to-number resolution uses a compile-time lookup table covering all 373 x86_64 syscalls. Unknown syscall names cause the helper to exit with an error rather than silently allowing them.

### Layer 4: Capability dropping

Linux capabilities provide fine-grained privilege control. After applying Landlock and closing excess fds, the helper drops **all** capabilities from the effective, permitted, and inheritable sets using `capset(2)`. The ambient capability set is cleared via `prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL)`.

This ensures the sandboxed process cannot use any privileged kernel operations, even if the parent had capabilities.

### Layer 5: Privilege escalation prevention

Before any sandbox enforcement, the helper sets `PR_SET_NO_NEW_PRIVS` via `prctl(2)`. This is a one-way flag that prevents `exec` from gaining privileges through setuid/setgid binaries. Once set, it cannot be unset and is inherited by all child processes.

---

## Enforcement order

The enforcement order within the helper is critical for correctness:

```
1. PR_SET_NO_NEW_PRIVS     <- Must be first (required by seccomp)
2. Landlock ruleset         <- Must be before fd close (opens path fds)
3. Close all fds > 2        <- Must be before seccomp (close_range not in allowlist)
4. Drop capabilities        <- Must be before seccomp (capset not in allowlist)
5. seccomp-BPF filter       <- Must be last enforcement (locks syscalls for exec'd process)
6. exec(command)            <- All restrictions inherited by child
```

**Why this order matters:**
- Landlock uses `open(O_PATH)`, `fstat()`, and `landlock_*` syscalls that seccomp would block
- `close_range(2)` closes fd 3 (policy) and any Landlock path fds; must happen before seccomp blocks it
- `capset(2)` would be blocked by seccomp if applied after
- seccomp is applied last so all setup syscalls are available during enforcement setup

---

## Policy format

The policy JSON written to the temp file (and passed to the helper via `--policy-file`) contains only the fields relevant to the helper (namespace and network isolation are handled by the outer sandbox-runtime layer):

```json
{
  "filesystem": {
    "allow": [
      { "path": "/tmp/workdir", "access": "readwrite" },
      { "path": "/usr", "access": "read" },
      { "path": "/bin", "access": "execute" }
    ],
    "deny": []
  },
  "syscalls": {
    "allow": ["read", "write", "exit", "exit_group", "..."],
    "defaultDeny": true
  }
}
```

The full `SandboxPolicy` type (in TypeScript) also includes `network`, `namespaces`, and `timeoutMs` -- these are consumed by the Node.js layer and translated to `SandboxRuntimeConfig` for sandbox-runtime, not passed to the helper.

---

## Helper discovery and integrity

### Discovery order

`findHelper()` searches for the helper binary in this order:

1. **`SAFECLAW_HELPER_PATH`** environment variable -- for custom installations and testing
2. **Co-located path** -- `native/safeclaw-sandbox-helper` relative to the package
3. **User install path** -- `~/.safeclaw/bin/safeclaw-sandbox-helper`
4. **System PATH** -- resolved via `which`

If the helper is found and executable, the full enforcement stack (outer sandbox-runtime container + inner Landlock + seccomp + capability drop) is active. If not found, only the outer sandbox-runtime layer is applied.

> **TODO:** Re-add SHA-256 integrity verification of the helper binary once builds are reproducible. Currently, the binary hash changes across compiler versions and build environments, making a hardcoded hash impractical without a release process that stamps it.

### Graceful degradation

| Platform | Helper status | Enforcement |
|----------|---------------|-------------|
| Linux | Found | bwrap container (pivot_root + namespaces) + Landlock + seccomp + capability drop |
| Linux | Not found | bwrap container only (pivot_root + namespaces) |
| macOS | N/A | sandbox-exec profile only |

The `SandboxResult.enforcement` field reports which layers were active:

```typescript
interface EnforcementLayers {
  namespaces: boolean;   // Linux namespaces active (bwrap)
  pivotRoot: boolean;    // pivot_root filesystem isolation (bwrap on Linux)
  bindMounts: boolean;   // bind-mounted paths (always true when sandbox-runtime runs)
  landlock: boolean;     // Landlock filesystem restrictions active (C helper)
  seccomp: boolean;      // seccomp-BPF syscall filter active (Linux + helper)
  capDrop: boolean;      // all capabilities dropped (C helper)
}
```

---

## Helper binary properties

| Property | Value |
|----------|-------|
| Language | C11 (`-std=c11 -Wall -Wextra -Werror -pedantic`) |
| Linking | Static (musl libc) -- no runtime dependencies |
| Size | ~800 KB (unstripped) |
| Architecture | x86_64 (aarch64 planned) |
| Source | `native/src/` (~1,200 lines across 10 source/header files) |
| Input | Policy JSON on fd 3 (max 64 KiB) |
| Output | Inherits stdout/stderr from parent |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Target command exited successfully |
| 70 | Policy parse error (invalid JSON, missing fields) |
| 71 | Landlock setup failed |
| 72 | seccomp setup failed |
| 73 | Capability drop failed |
| 74 | exec failed (command not found, permission denied) |
| 75 | Permission error (policy file mode/ownership, NO_NEW_PRIVS failure) |
| 76 | Setuid/setgid detected -- refusing to run |

---

## Threat model

### What the sandbox protects against

| Threat | Mitigation |
|--------|------------|
| Malicious file access | Landlock restricts filesystem to declared paths only |
| Arbitrary syscall use | seccomp-BPF kills process on undeclared syscalls |
| Network exfiltration | Network namespace provides complete isolation |
| Privilege escalation via setuid | NO_NEW_PRIVS prevents privilege gain through exec |
| Capability abuse | All capabilities dropped before exec |
| Process interference | PID namespace isolates process tree |
| Mount manipulation | Mount namespace isolates filesystem view |
| Helper binary tampering | File permissions and installation path trust (SHA-256 verification planned) |
| Fd leakage from parent | Helper closes all fds > 2 before exec |
| Runaway processes | Timeout-based kill with process group SIGKILL |

### What it does NOT protect against

| Limitation | Reason |
|------------|--------|
| Kernel exploits | Sandbox runs on the same kernel; a kernel vulnerability could escape |
| Side-channel attacks | Timing, cache, and speculative execution attacks are out of scope |
| Resource exhaustion | No cgroup-based CPU/memory limits (planned for future) |
| Filesystem races (TOCTOU) | Landlock rules are applied atomically, but the policy is resolved before spawn |
| Same-user process interference | User namespace mapping means the sandboxed process runs as the same UID outside the namespace |

---

## Platform requirements

### Linux

- **Kernel >= 5.13** -- for Landlock LSM support
- **seccomp-BPF** -- enabled in kernel config (`CONFIG_SECCOMP_FILTER=y`)
- **User namespaces** -- `sysctl kernel.unprivileged_userns_clone=1` (default on most distros)
- **bubblewrap** -- `bwrap` binary in PATH (`apt install bubblewrap`)
- **socat** -- required by sandbox-runtime network proxy (`apt install socat`)

### macOS

- macOS 10.14+ (Mojave) for sandbox-exec support
- socat (`brew install socat`) for network proxy

The `safeclaw onboard` command checks these requirements during setup. The `detectKernelCapabilities()` function provides programmatic detection. `safeclaw doctor` runs `bwrapCheck`, `socatCheck`, and `platformCheck` to verify the environment.

---

## Developing with the sandbox

### Building the helper

```bash
cd native
make clean all    # Builds safeclaw-sandbox-helper (requires musl-gcc)
make check        # Runs 75 native tests
```

### Running tests

```bash
pnpm test                    # All TypeScript tests (includes sandbox unit + integration tests)
cd native && make check      # Native C tests
```

### Debugging sandbox issues

Set `SAFECLAW_HELPER_PATH` to point to a debug build:

```bash
cd native
CFLAGS="-O0 -g" make clean all
export SAFECLAW_HELPER_PATH=$PWD/safeclaw-sandbox-helper
safeclaw chat
```

The helper writes diagnostic messages to stderr, which are captured in `SandboxResult.stderr`.

### Custom policies

Tools declare required capabilities in their manifest. The tool orchestrator builds a `SandboxPolicy` by merging the tool's declared needs with the default restrictive policy. You can inspect the effective policy:

```typescript
const sandbox = new Sandbox(policy);
// policy is passed to the helper as JSON on fd 3
```
