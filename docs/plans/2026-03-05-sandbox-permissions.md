# Sandbox Command Execution & Working Directory Permissions

> SafeClaw v2 — Feature 1 & 2 (combined, tightly coupled)

## Problem

The default `SandboxPolicy` grants zero filesystem access. Sandboxed bash commands can't run anything — no `/bin/ls`, no `git status`, no `pnpm test`. SafeClaw is unusable for real development work.

## Design Decisions

- **Allowlist approach**: maintain a curated list of safe system paths. Commands not on the list produce a warning, not silent failure.
- **CWD full access**: the project directory where SafeClaw was launched gets readwrite+execute.
- **Network stays none**: sandboxed commands don't get network. Tools that need network (web-fetch, web-search) already run unsandboxed.

## Architecture

A new `PolicyBuilder` class in `packages/sandbox/` constructs a `SandboxPolicy`:

```typescript
class PolicyBuilder {
  static forDevelopment(cwd: string): SandboxPolicy;
  addReadExecute(path: string): this;
  addReadWrite(path: string): this;
  addReadOnly(path: string): this;
  build(): SandboxPolicy;
}
```

### Safe path allowlist (read+execute)

| Path | Reason |
|------|--------|
| `/bin`, `/usr/bin`, `/usr/local/bin` | Standard command locations |
| `/usr/lib`, `/lib`, `/lib64` | Shared libraries |
| `/etc` | Read-only config (passwd, resolv.conf, etc.) |
| `/proc/self` | Needed by Node.js and many tools |
| Node.js install path | Runtime execution |
| pnpm global store | Package resolution |

### Readwrite paths

| Path | Reason |
|------|--------|
| `process.cwd()` | Project directory — full access |
| `/tmp` | Many tools need temp files |
| `~/.safeclaw/` | Vault access, config |

### Device nodes (read-only)

`/dev/null`, `/dev/urandom`, `/dev/zero`

### Seccomp expansion

Expand allowed syscall list beyond the current 26 to include what common dev tools need:

`openat`, `stat`, `lstat`, `readlink`, `getdents64`, `pipe2`, `dup2`, `socket`, `connect`, `sendto`, `recvfrom`, `poll`, `epoll_create1`, `epoll_ctl`, `epoll_wait`, `futex`, `clock_gettime`, `newfstatat`, `sigaltstack`, `clone3`, `sched_getaffinity`, `sched_yield`, `mremap`, `madvise`, `getuid`, `getgid`, `geteuid`, `getegid`, `getppid`, `getgroups`, `sysinfo`, `statfs`, `fstatfs`, `dup`, `pipe`, `nanosleep`, `alarm`, `setitimer`, `getitimer`, `chdir`, `fchdir`, `rename`, `renameat`, `renameat2`, `mkdir`, `mkdirat`, `rmdir`, `unlink`, `unlinkat`, `symlink`, `symlinkat`, `readlinkat`, `chmod`, `fchmod`, `fchmodat`, `chown`, `fchown`, `lchown`, `umask`, `gettimeofday`, `getrlimit`, `setrlimit`, `times`, `truncate`, `ftruncate`, `utimensat`, `fallocate`, `openat2`, `close_range`, `copy_file_range`, `sendfile`, `splice`, `tee`, `inotify_init1`, `inotify_add_watch`, `inotify_rm_watch`, `eventfd2`, `timerfd_create`, `timerfd_settime`, `timerfd_gettime`, `signalfd4`, `accept4`, `socketpair`, `bind`, `listen`, `getsockname`, `getpeername`, `setsockopt`, `getsockopt`, `shutdown`, `recvmsg`, `sendmsg`, `select`, `pselect6`, `ppoll`, `wait4`, `waitid`, `kill`, `tgkill`, `rt_sigreturn`, `rt_sigtimedwait`, `rt_sigqueueinfo`, `prctl`, `execveat`, `memfd_create`, `statx`, `io_uring_setup`, `io_uring_enter`, `io_uring_register`

### Command validation

Before executing a bash command, extract the binary name and check if it resolves to a path within the allowlist. If not, return a warning message to the agent rather than failing silently.

## Tasks

### Task 1: PolicyBuilder class

**File**: `packages/sandbox/src/policy-builder.ts`

Create `PolicyBuilder` with:
- `static forDevelopment(cwd: string): SandboxPolicy` — constructs the full development policy
- `addReadExecute(path)`, `addReadWrite(path)`, `addReadOnly(path)` — builder methods
- `build()` — returns the final `SandboxPolicy`
- Helper to detect Node.js install path (`process.execPath` → dirname → dirname)
- Helper to detect pnpm store path (`pnpm store path` or fallback to `~/.local/share/pnpm/store`)

**Test**: `packages/sandbox/src/policy-builder.test.ts`
- forDevelopment() includes all expected paths
- CWD is readwrite
- System paths are read+execute
- /tmp is readwrite
- Device nodes included
- Expanded syscall list present
- Network is "none"

### Task 2: Export and integrate PolicyBuilder

**Files**:
- `packages/sandbox/src/index.ts` — export `PolicyBuilder`
- `packages/cli/src/commands/bootstrap.ts` — replace `DEFAULT_POLICY` with `PolicyBuilder.forDevelopment(process.cwd())` for bash tool sandboxing

**Test**: Update `bootstrap.test.ts` if needed to verify new policy is used.

### Task 3: Command validation in bash tool

**File**: `packages/core/src/tools/builtin/bash.ts`

Before executing, resolve the command binary path. If it's not within an allowed path, return a warning message in the tool result:
```
Warning: Command '/some/path/binary' is not on the allowed commands list.
Allowed paths: /bin, /usr/bin, /usr/local/bin, [CWD]
```

The agent can then adjust its approach. This is advisory, not blocking — the sandbox's Landlock rules are the real enforcement.

**Test**: `packages/core/src/tools/builtin/bash.test.ts` — add tests for command validation warnings.

### Task 4: Documentation

Update:
- `AGENTS.md` — document PolicyBuilder, expanded syscalls
- `docs/architecture.md` — update sandbox section
- `docs/security-model.md` — document the development policy allowlist
