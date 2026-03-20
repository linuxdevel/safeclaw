# Bubblewrap Sandbox Integration Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `unshare(1)` with bubblewrap (`bwrap`) to add `pivot_root` filesystem isolation, while keeping the C helper for Landlock + seccomp + capability dropping as a defense-in-depth inner layer.

**Architecture:** The new spawn chain is `bwrap [bind-mount + namespace flags] -- helper -- command [args]`. Bwrap provides coarse filesystem isolation via `pivot_root` + bind mounts (paths not explicitly bound are invisible), while the C helper provides fine-grained enforcement via Landlock + seccomp-BPF + capability dropping inside that container.

**Tech Stack:** bubblewrap (system package), existing C helper (musl-gcc), TypeScript sandbox package.

---

## Motivation

The current sandbox uses `unshare(1)` for namespace isolation and Landlock for filesystem access control. This has a critical weakness: Landlock restricts *access* but the full host filesystem tree is *visible* to sandboxed processes. If Landlock has a kernel bug, the host filesystem is fully exposed with no fallback.

Bubblewrap's `pivot_root(2)` creates a completely new filesystem root. Paths not explicitly bind-mounted into the sandbox simply do not exist. This provides a structural boundary that is independent of Landlock, creating two independent filesystem enforcement layers.

### Additional improvements

- **IPC namespace** (`--unshare-ipc`): Blocks shared memory from host
- **UTS namespace** (`--unshare-uts`): Isolates hostname
- **Minimal `/dev`** (`--dev /dev`): Only null, zero, urandom, etc.
- **Controlled `/proc`** (`--proc /proc`): Scoped to PID namespace
- **Clean `/tmp`** (`--tmpfs /tmp`): Fresh tmpfs, not host's `/tmp`
- **Orphan prevention** (`--die-with-parent`): Kill sandbox if SafeClaw dies
- **Terminal injection prevention** (`--new-session`): New session ID blocks TIOCSTI
- **Selective home directory**: Only specific safe dotdirs are bind-mounted, not the entire `~/`. `~/.ssh`, `~/.aws`, `~/.gnupg` are structurally absent.

---

## New Spawn Chain

### Before

```
unshare --pid --fork --net --mount --user --map-root-user \
  -- /path/to/helper \
  -- /bin/bash -c "npm test"
```

### After

```
bwrap \
  --unshare-pid --unshare-net --unshare-ipc --unshare-uts \
  --unshare-user \
  --die-with-parent --new-session \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --ro-bind /sbin /sbin \
  --ro-bind /etc /etc \
  --bind /home/user/project /home/user/project \
  --ro-bind /home/user/.config /home/user/.config \
  --ro-bind /home/user/.gitconfig /home/user/.gitconfig \
  ... \
  --ro-bind /path/to/helper /path/to/helper \
  -- /path/to/helper \
  -- /bin/bash -c "npm test"
```

Policy JSON continues to be passed via fd 3 (pipe). bwrap does not interfere with inherited fds.

---

## Type Changes

### `EnforcementLayers` (types.ts)

```typescript
export interface EnforcementLayers {
  namespaces: boolean;
  pivotRoot: boolean;     // NEW: bwrap's pivot_root was used
  bindMounts: boolean;    // NEW: bwrap bind-mount isolation was active
  landlock: boolean;
  seccomp: boolean;
  capDrop: boolean;
}
```

### `KernelCapabilities` (types.ts)

```typescript
export interface KernelCapabilities {
  landlock: { supported: boolean; abiVersion: number };
  seccomp: { supported: boolean };
  namespaces: { user: boolean; pid: boolean; net: boolean; mnt: boolean };
  bwrap: { available: boolean; path: string | undefined; version: string | undefined };  // NEW
}
```

### `DevelopmentPolicyOptions` (policy-builder.ts)

```typescript
export interface DevelopmentPolicyOptions {
  extraExecutePaths?: string[];
  extraReadWritePaths?: string[];
  extraReadOnlyPaths?: string[];    // NEW
  extraHomeDirs?: string[];         // NEW: additional safe home dotdirs to bind-mount
}
```

---

## PolicyBuilder Changes

### New `toBwrapArgs()` method

Translates the existing `PathRule[]` allow list into bwrap bind-mount arguments:

| PathRule access | bwrap flag |
|-----------------|-----------|
| `read` | `--ro-bind path path` |
| `write`, `readwrite` | `--bind path path` |
| `execute` | `--ro-bind path path` |
| `readwriteexecute` | `--bind path path` |

Special-cased paths that bwrap handles natively:
- `/tmp` -> `--tmpfs /tmp` (already in base flags)
- `/dev/null`, `/dev/zero`, `/dev/urandom` -> `--dev /dev` (already in base flags)
- `/proc/self` -> `--proc /proc` (already in base flags)

The helper binary path is also bind-mounted read-only so it is accessible inside the sandbox.

### Selective home directory in `forDevelopment()`

Replace `builder.addReadOnly(homedir())` with selective dotdir bind-mounts:

```typescript
const SAFE_HOME_DIRS = [
  ".config",
  ".local/share",
  ".local/bin",
  ".npm",
  ".npmrc",
  ".cache",
  ".nvm",
  ".gitconfig",
  ".gitignore_global",
];
```

Only dirs that exist on disk are added. `extraHomeDirs` option allows users to add more (e.g., `.cargo/bin`, `.rustup`).

**Explicitly NOT included:** `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.gcloud`.

### Return type change

`PolicyBuilder.forDevelopment()` currently returns `SandboxPolicy`. It should return the `PolicyBuilder` instance so consumers can call both `build()` and `toBwrapArgs()`:

```typescript
// Before
static forDevelopment(cwd: string, options?: DevelopmentPolicyOptions): SandboxPolicy

// After
static forDevelopment(cwd: string, options?: DevelopmentPolicyOptions): PolicyBuilder
```

All call sites update from `PolicyBuilder.forDevelopment(cwd)` to `PolicyBuilder.forDevelopment(cwd).build()`.

---

## Sandbox Class Changes

### Constructor

```typescript
export class Sandbox {
  private readonly policy: SandboxPolicy;
  private readonly bwrapPath: string;
  private readonly bwrapArgs: string[];
  private readonly helperPath: string | undefined;

  constructor(policy: SandboxPolicy, bwrapArgs: string[]) {
    assertSandboxSupported();
    this.policy = policy;
    this.bwrapPath = findBwrap();   // throws if not found (mandatory)
    this.bwrapArgs = bwrapArgs;
    this.helperPath = findHelper();
  }
}
```

### execute() -- new 4-case structure

```
if (bwrap && helper) -> bwrap [args] -- helper -- command [cmdArgs]
if (bwrap)           -> bwrap [args] -- command [cmdArgs]
if (helper)          -> helper -- command [cmdArgs]
else                 -> command [cmdArgs]  (no sandbox)
```

The `buildUnshareFlags()` private method is removed entirely.

### Timeout enforcement

Unchanged: `setTimeout` + `process.kill(-proc.pid, 'SIGKILL')`. bwrap's `--die-with-parent` provides an additional safety net.

---

## Detection Changes (detect.ts)

### New `findBwrap()` function

```typescript
export function findBwrap(): string {
  // 1. SAFECLAW_BWRAP_PATH env var
  // 2. which bwrap
  // Throws if not found
}
```

### `detectKernelCapabilities()` additions

Probe bwrap availability via `which bwrap` and `bwrap --version`.

### `assertSandboxSupported()` additions

Add bwrap to mandatory requirements:
```
if (!caps.bwrap.available) missing.push("bubblewrap (install: apt install bubblewrap)");
```

---

## Bootstrap Changes (bootstrap.ts)

```typescript
// Before
const sandboxPolicy = PolicyBuilder.forDevelopment(process.cwd());
const sandbox = new Sandbox(sandboxPolicy);

// After
const builder = PolicyBuilder.forDevelopment(process.cwd());
const sandboxPolicy = builder.build();
const bwrapArgs = builder.toBwrapArgs(findHelper());
const sandbox = new Sandbox(sandboxPolicy, bwrapArgs);
```

---

## Doctor Command Changes

Add bwrap check:
```
Checking system requirements...
  [OK] Kernel 6.5.0 (>= 5.13 required)
  [OK] Landlock ABI v3
  [OK] seccomp-BPF
  [OK] User namespaces
  [OK] PID namespaces
  [OK] bubblewrap 0.9.0 (/usr/bin/bwrap)     <-- NEW
  [OK] Sandbox helper
```

---

## Testing

### Unit tests (sandbox.test.ts)

- Verify spawn args include `bwrap` instead of `unshare`
- Verify bwrap args include `--die-with-parent`, `--new-session`, namespace flags
- Verify bind mount args match policy allow rules
- Verify fd 3 pipe is set up for policy JSON
- Verify `EnforcementLayers` includes `pivotRoot: true` and `bindMounts: true`

### Integration tests (integration.test.ts)

- `echo hello` through full bwrap + helper chain
- Verify `ls ~/.ssh` fails inside sandbox (directory does not exist)
- Verify host paths not in allow list are invisible
- Verify `/tmp` is empty (fresh tmpfs)
- Verify `/proc` is scoped to PID namespace

### Security tests (test/security/)

- Sandbox escape: verify process cannot access paths outside bind mounts
- Home directory: verify `~/.ssh`, `~/.aws`, `~/.gnupg` are inaccessible
- Network: verify network namespace still blocks outbound connections
- IPC: verify shared memory from host is not accessible
- Terminal injection: verify TIOCSTI is blocked by `--new-session`

---

## Files Modified

| File | Change type |
|------|------------|
| `packages/sandbox/src/types.ts` | Modify: extend `EnforcementLayers`, `KernelCapabilities` |
| `packages/sandbox/src/policy-builder.ts` | Modify: add `toBwrapArgs()`, selective home dirs, extend options, change `forDevelopment()` return |
| `packages/sandbox/src/sandbox.ts` | Modify: replace unshare with bwrap, new constructor signature |
| `packages/sandbox/src/detect.ts` | Modify: add bwrap detection, update `assertSandboxSupported()` |
| `packages/sandbox/src/helper.ts` | Modify: add `findBwrap()` export |
| `packages/sandbox/src/index.ts` | Modify: export new types/functions |
| `packages/sandbox/src/sandbox.test.ts` | Modify: update all spawn chain tests |
| `packages/sandbox/src/integration.test.ts` | Modify: add bwrap integration tests |
| `packages/cli/src/commands/bootstrap.ts` | Modify: pass builder/bwrapArgs to Sandbox |
| `packages/cli/src/commands/doctor.ts` | Modify: add bwrap check |
| `test/security/sandbox-escape.test.ts` | Modify: add pivot_root and home dir tests |
| `docs/sandboxing.md` | Modify: update architecture, layer descriptions |
| `docs/getting-started.md` | Modify: add bwrap prerequisite |
| `docs/security-model.md` | Modify: update threat model |
| `README.md` | Modify: update features and requirements |
| `AGENTS.md` | Modify: update sandbox description |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| bwrap not available on some Linux distros | Mandatory dependency, checked by `assertSandboxSupported()` and `doctor`. Available in all major distro repos. |
| Bind-mount list incomplete (tools break) | `DevelopmentPolicyOptions.extraReadOnlyPaths` and `extraHomeDirs` allow users to extend. Error messages from bwrap are clear about missing paths. |
| Performance overhead of bwrap vs unshare | Negligible -- bwrap is a single C binary that does setup and execs. The kernel operations are the same. |
| bwrap + helper interaction issues (fd inheritance) | bwrap passes through fds by default. fd 3 pipe will work unchanged. Integration tests verify the full chain. |
| Removing full homedir read breaks git/npm | Selective dotdir list includes `.gitconfig`, `.npmrc`, `.npm`, `.config`, `.cache`. Test with common workflows. |
