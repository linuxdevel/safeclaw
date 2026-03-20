# Sandbox Runtime Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SafeClaw's custom namespace/bwrap code with `@anthropic-ai/sandbox-runtime` as the outer isolation layer, gaining macOS support, network domain filtering, and socat-based proxy control, while retaining the C helper (Landlock + seccomp + cap-drop) as an inner layer inside bwrap.

**Architecture:** Phase 1 wires `SandboxManager.wrapWithSandbox()` into the `Sandbox` class, which becomes an adapter translating `SandboxPolicy` → `SandboxRuntimeConfig`. Phase 2 injects the C helper as the inner process by writing a policy temp file and passing `--policy-file` (the helper already supports this flag — no C changes needed). The spawn chain becomes: `bwrap [sandbox-runtime] → helper [Landlock+seccomp+cap-drop] → command`.

**Tech Stack:** `@anthropic-ai/sandbox-runtime` pinned to git SHA `20f5176a94314038695bee13779eb9eebbbaeb49`, existing C helper binary, TypeScript (ESM strict), vitest.

**Supersedes:** `docs/plans/2026-03-07-bubblewrap-sandbox-design.md` — that plan assumed SafeClaw would implement bwrap directly; this delegates to sandbox-runtime instead and additionally gains macOS + network proxy support.

---

## File Map

| File | Change |
|------|--------|
| `packages/sandbox/package.json` | Add `@anthropic-ai/sandbox-runtime` git dep |
| `packages/sandbox/src/types.ts` | Extend `NetworkPolicy`, `EnforcementLayers`, `KernelCapabilities` |
| `packages/sandbox/src/policy-builder.ts` | Add `toRuntimeConfig()` method; extend `DevelopmentPolicyOptions` for network |
| `packages/sandbox/src/policy-builder.test.ts` | Add `toRuntimeConfig()` tests |
| `packages/sandbox/src/detect.ts` | Replace `unshare` check with sandbox-runtime dep checks |
| `packages/sandbox/src/detect.test.ts` | Update detect tests |
| `packages/sandbox/src/sandbox.ts` | Rewrite `execute()` to use `SandboxManager.wrapWithSandbox()` |
| `packages/sandbox/src/sandbox.test.ts` | Update spawn chain tests |
| `packages/sandbox/src/index.ts` | Export new `NetworkPolicy` type |
| `packages/cli/src/commands/bootstrap.ts` | Call `SandboxManager.initialize()` before `new Sandbox()` |
| `packages/cli/src/commands/bootstrap.test.ts` | Add initialize call test |
| `packages/cli/src/commands/doctor-checks.ts` | Replace `unshareCheck`; add `bwrapCheck`, `socatCheck`, `ripgrepCheck` |
| `packages/cli/src/commands/doctor-checks.test.ts` | Update check tests |
| `packages/cli/src/commands/doctor.ts` | Update check list |

---

## Phase 1 — sandbox-runtime as outer isolation layer

### Task 1: Add @anthropic-ai/sandbox-runtime dependency

**Files:**
- Modify: `packages/sandbox/package.json`

- [ ] **Step 1: Add the git dependency**

```json
{
  "name": "@safeclaw/sandbox",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "git+ssh://git@github.com/anthropic-experimental/sandbox-runtime.git#20f5176a94314038695bee13779eb9eebbbaeb49"
  },
  "files": ["dist"]
}
```

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: resolves without error. `node_modules/@anthropic-ai/sandbox-runtime` exists.

- [ ] **Step 3: Verify types resolve**

```bash
pnpm typecheck
```

Expected: PASS (no type errors yet — we haven't imported it).

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox/package.json pnpm-lock.yaml
git commit -m "chore(sandbox): add @anthropic-ai/sandbox-runtime git dependency"
```

---

### Task 2: Extend types

**Files:**
- Modify: `packages/sandbox/src/types.ts`
- Modify: `packages/sandbox/src/index.ts`

Background: `SandboxPolicy.network` is currently `"none" | "localhost" | "filtered"`. We extend it to support a structured domain-allowlist variant. `EnforcementLayers` gains `pivotRoot` and `bindMounts`. `KernelCapabilities` gains `bwrap`.

- [ ] **Step 1: Write type tests first** (in `packages/sandbox/src/types.test.ts`, new file)

```typescript
import { describe, it, expectTypeOf } from "vitest";
import type { NetworkPolicy, SandboxPolicy, EnforcementLayers, KernelCapabilities } from "./types.js";

describe("NetworkPolicy", () => {
  it("accepts 'none'", () => {
    const n: NetworkPolicy = "none";
    expectTypeOf(n).toMatchTypeOf<NetworkPolicy>();
  });

  it("accepts domain allowlist object", () => {
    const n: NetworkPolicy = { allowedDomains: ["github.com", "*.npmjs.org"] };
    expectTypeOf(n).toMatchTypeOf<NetworkPolicy>();
  });

  it("accepts domain allowlist with deniedDomains", () => {
    const n: NetworkPolicy = { allowedDomains: [], deniedDomains: ["evil.com"] };
    expectTypeOf(n).toMatchTypeOf<NetworkPolicy>();
  });
});

describe("EnforcementLayers", () => {
  it("has pivotRoot and bindMounts fields", () => {
    const e: EnforcementLayers = {
      namespaces: true, pivotRoot: true, bindMounts: true,
      landlock: false, seccomp: false, capDrop: false,
    };
    expectTypeOf(e.pivotRoot).toBeBoolean();
    expectTypeOf(e.bindMounts).toBeBoolean();
  });
});

describe("KernelCapabilities", () => {
  it("has bwrap field", () => {
    const k: KernelCapabilities = {
      landlock: { supported: true, abiVersion: 3 },
      seccomp: { supported: true },
      namespaces: { user: true, pid: true, net: true, mnt: true },
      bwrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
    };
    expectTypeOf(k.bwrap.available).toBeBoolean();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/sandbox -- types.test
```

Expected: FAIL — `NetworkPolicy`, `pivotRoot`, `bindMounts`, `bwrap` not yet defined.

- [ ] **Step 3: Update `packages/sandbox/src/types.ts`**

```typescript
/** Filesystem access rule for Landlock */
export interface PathRule {
  path: string;
  access: "read" | "write" | "readwrite" | "execute" | "readwriteexecute";
}

/**
 * Network policy for a sandbox execution.
 * - "none": block all outbound network (net namespace, no proxy)
 * - "localhost": allow only loopback
 * - object: route through sandbox-runtime proxy with domain allowlist/denylist
 */
export type NetworkPolicy =
  | "none"
  | "localhost"
  | { allowedDomains: string[]; deniedDomains?: string[] };

/** Sandbox policy — defines isolation constraints for a single execution */
export interface SandboxPolicy {
  filesystem: { allow: PathRule[]; deny: PathRule[] };
  syscalls: { allow: string[]; defaultDeny: true };
  network: NetworkPolicy;
  namespaces: { pid: boolean; net: boolean; mnt: boolean; user: boolean };
  timeoutMs?: number | undefined;
}

/** Which enforcement layers were active during execution */
export interface EnforcementLayers {
  namespaces: boolean;
  pivotRoot: boolean;    // bwrap pivot_root was used
  bindMounts: boolean;   // bwrap bind-mount FS isolation was active
  landlock: boolean;
  seccomp: boolean;
  capDrop: boolean;
}

/** Result of a sandboxed execution */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  killReason?: "timeout" | "oom" | "signal" | undefined;
  enforcement?: EnforcementLayers | undefined;
}

/** Kernel feature availability */
export interface KernelCapabilities {
  landlock: { supported: boolean; abiVersion: number };
  seccomp: { supported: boolean };
  namespaces: { user: boolean; pid: boolean; net: boolean; mnt: boolean };
  bwrap: { available: boolean; path: string | undefined; version: string | undefined };
}

/** Default sandbox policy — maximum restriction */
export const DEFAULT_POLICY: SandboxPolicy = {
  filesystem: { allow: [], deny: [] },
  syscalls: {
    allow: [
      "read", "write", "exit", "exit_group", "brk", "mmap", "close",
      "fstat", "mprotect", "munmap", "rt_sigaction", "rt_sigprocmask",
      "ioctl", "access", "getpid", "clone", "execve", "wait4", "uname",
      "fcntl", "getcwd", "arch_prctl", "set_tid_address", "set_robust_list",
      "rseq", "prlimit64", "getrandom",
    ],
    defaultDeny: true,
  },
  network: "none",
  namespaces: { pid: true, net: true, mnt: true, user: true },
  timeoutMs: 30_000,
};
```

- [ ] **Step 4: Export `NetworkPolicy` from `packages/sandbox/src/index.ts`**

Add to existing exports:
```typescript
export type { NetworkPolicy } from "./types.js";
```

- [ ] **Step 5: Fix compilation breakage in policy-builder.ts**

In `policy-builder.ts`, `build()` returns `SandboxPolicy`. The `network: "none"` literal still works because `"none"` is part of `NetworkPolicy`. No change needed.

Check existing tests still type-check:
```bash
pnpm typecheck
```

Expected: PASS (or only errors about code that explicitly checks `=== "filtered"` — fix those by checking `typeof policy.network === "object"`).

- [ ] **Step 6: Run the new type tests**

```bash
pnpm test --filter @safeclaw/sandbox -- types.test
```

Expected: PASS.

- [ ] **Step 7: Run all sandbox tests**

```bash
pnpm test --filter @safeclaw/sandbox
```

Expected: PASS. (The existing tests reference `network: "none"` which is still valid.)

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox/src/types.ts packages/sandbox/src/types.test.ts packages/sandbox/src/index.ts
git commit -m "feat(sandbox): extend NetworkPolicy type and EnforcementLayers/KernelCapabilities"
```

---

### Task 3: PolicyBuilder.toRuntimeConfig()

**Files:**
- Modify: `packages/sandbox/src/policy-builder.ts`
- Modify: `packages/sandbox/src/policy-builder.test.ts`

Background: `SandboxRuntimeConfig` (from sandbox-runtime) uses a different model than SafeClaw's Landlock-style `SandboxPolicy`:
- **Reads**: sandbox-runtime is permissive-by-default (deny specific dirs) vs SafeClaw's allowlist-only. We translate by denying the sensitive home dirs and letting everything else be readable.
- **Writes**: both use allowlist-only. Map `readwrite`/`readwriteexecute` PathRules to `filesystem.allowWrite`.
- **Network**: `"none"` → `allowedDomains: []`; object → pass through.

The sensitive dirs always denied for reads (credentials/config that must not leak):
```
~/.ssh  ~/.aws  ~/.gnupg  ~/.kube  ~/.docker  ~/.gcloud  ~/.azure
```

- [ ] **Step 1: Write failing tests for `toRuntimeConfig()` in `policy-builder.test.ts`**

Add to the existing test file:

```typescript
import { homedir } from "node:os";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

describe("PolicyBuilder.toRuntimeConfig()", () => {
  it("maps readwrite PathRules to allowWrite", () => {
    const policy = new PolicyBuilder()
      .addReadWrite("/project")
      .addReadWrite("/tmp")
      .build();
    const rtConfig: SandboxRuntimeConfig = PolicyBuilder.toRuntimeConfig(policy);
    expect(rtConfig.filesystem.allowWrite).toContain("/project");
    expect(rtConfig.filesystem.allowWrite).toContain("/tmp");
  });

  it("maps readwriteexecute PathRules to allowWrite", () => {
    const policy = new PolicyBuilder().addReadWriteExecute("/workspace").build();
    const rtConfig = PolicyBuilder.toRuntimeConfig(policy);
    expect(rtConfig.filesystem.allowWrite).toContain("/workspace");
  });

  it("does not add read-only or execute-only paths to allowWrite", () => {
    const policy = new PolicyBuilder()
      .addReadOnly("/etc")
      .addReadExecute("/usr/bin")
      .build();
    const rtConfig = PolicyBuilder.toRuntimeConfig(policy);
    expect(rtConfig.filesystem.allowWrite).not.toContain("/etc");
    expect(rtConfig.filesystem.allowWrite).not.toContain("/usr/bin");
  });

  it("adds sensitive home dirs to denyRead", () => {
    const policy = new PolicyBuilder().build();
    const rtConfig = PolicyBuilder.toRuntimeConfig(policy);
    const home = homedir();
    expect(rtConfig.filesystem.denyRead).toContain(`${home}/.ssh`);
    expect(rtConfig.filesystem.denyRead).toContain(`${home}/.aws`);
    expect(rtConfig.filesystem.denyRead).toContain(`${home}/.gnupg`);
  });

  it("maps network: 'none' to allowedDomains: []", () => {
    const policy = { ...DEFAULT_POLICY, network: "none" as const };
    const rtConfig = PolicyBuilder.toRuntimeConfig(policy);
    expect(rtConfig.network.allowedDomains).toEqual([]);
  });

  it("maps network object to allowedDomains/deniedDomains", () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_POLICY,
      network: { allowedDomains: ["github.com", "*.npmjs.org"], deniedDomains: ["evil.com"] },
    };
    const rtConfig = PolicyBuilder.toRuntimeConfig(policy);
    expect(rtConfig.network.allowedDomains).toEqual(["github.com", "*.npmjs.org"]);
    expect(rtConfig.network.deniedDomains).toEqual(["evil.com"]);
  });

  it("forDevelopment().toRuntimeConfig() includes cwd in allowWrite", () => {
    const cwd = "/home/user/project";
    const policy = PolicyBuilder.forDevelopment(cwd);
    const rtConfig = PolicyBuilder.toRuntimeConfig(policy);
    expect(rtConfig.filesystem.allowWrite).toContain(cwd);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/sandbox -- policy-builder.test
```

Expected: FAIL — `toRuntimeConfig` not defined.

- [ ] **Step 3: Add `toRuntimeConfig()` to `PolicyBuilder` in `policy-builder.ts`**

Add imports at the top:
```typescript
import { homedir } from "node:os";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxPolicy, NetworkPolicy } from "./types.js";
```

Add after the `build()` method and before `forDevelopment()`:

```typescript
/**
 * Translates a SafeClaw SandboxPolicy into a SandboxRuntimeConfig for
 * @anthropic-ai/sandbox-runtime.
 *
 * Read model difference: SafeClaw uses an allowlist (Landlock); sandbox-runtime
 * is permissive-by-default with an explicit denylist. We translate by denying
 * the sensitive credential dirs that must never be readable.
 *
 * Write model: both use allowlists. PathRules with access "readwrite" or
 * "readwriteexecute" map to filesystem.allowWrite.
 */
static toRuntimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
  // ── Filesystem ────────────────────────────────────────────────────
  const allowWrite = policy.filesystem.allow
    .filter((r) => r.access === "readwrite" || r.access === "readwriteexecute")
    .map((r) => r.path);

  // Always deny reads to credential/secret directories.
  // sandbox-runtime also enforces mandatory deny on dangerous files (.bashrc,
  // .git/hooks, etc.) regardless of this config — these are complementary.
  const home = homedir();
  const denyRead = [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.kube`,
    `${home}/.docker`,
    `${home}/.gcloud`,
    `${home}/.azure`,
  ];

  // ── Network ───────────────────────────────────────────────────────
  const network = buildNetworkConfig(policy.network);

  return {
    filesystem: {
      allowWrite,
      denyWrite: [],
      denyRead,
    },
    network,
  };
}
```

Add the private helper after the class:

```typescript
function buildNetworkConfig(
  network: NetworkPolicy,
): SandboxRuntimeConfig["network"] {
  if (network === "none") {
    return { allowedDomains: [], deniedDomains: [] };
  }
  if (network === "localhost") {
    return { allowedDomains: ["localhost"], deniedDomains: [] };
  }
  return {
    allowedDomains: network.allowedDomains,
    deniedDomains: network.deniedDomains ?? [],
  };
}
```

Also add the `DevelopmentPolicyOptions` extension for network:

```typescript
export interface DevelopmentPolicyOptions {
  extraExecutePaths?: string[];
  extraReadWritePaths?: string[];
  extraReadOnlyPaths?: string[];
  /**
   * Network domains the sandboxed process may connect to.
   * Default: [] (block all network). Use this to allow e.g. npm registry.
   * Example: ["registry.npmjs.org", "*.github.com"]
   */
  allowedNetworkDomains?: string[];
}
```

And update `forDevelopment()` to apply it (near the end of the method):

```typescript
// ── Network ──────────────────────────────────────────────────────────
const networkPolicy: NetworkPolicy =
  options?.allowedNetworkDomains !== undefined
    ? { allowedDomains: options.allowedNetworkDomains }
    : "none";

return { ...builder.build(), network: networkPolicy };
```

> Note: `forDevelopment()` currently calls `builder.build()` which hard-codes `network: "none"`. Extract to a local variable so the override can be applied.

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter @safeclaw/sandbox -- policy-builder.test
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/src/policy-builder.ts packages/sandbox/src/policy-builder.test.ts
git commit -m "feat(sandbox): add PolicyBuilder.toRuntimeConfig() translating to SandboxRuntimeConfig"
```

---

### Task 4: Update detect.ts

**Files:**
- Modify: `packages/sandbox/src/detect.ts`
- Modify: `packages/sandbox/src/detect.test.ts`

Background: `detect.ts` currently checks `unshare`, Landlock kernel version, and seccomp. We replace this with sandbox-runtime's `SandboxManager.checkDependencies()` for the platform-specific checks, and probe for `bwrap` directly for `KernelCapabilities`. The Linux-only restriction is removed — macOS is now supported via `sandbox-exec`.

- [ ] **Step 1: Write failing detect tests**

Replace the existing `detect.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsSupportedPlatform = vi.fn<() => boolean>();
const mockCheckDeps = vi.fn<() => { errors: string[]; warnings: string[] }>();
const mockWhichBwrap = vi.fn<() => string | null>();

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    isSupportedPlatform: mockIsSupportedPlatform,
    checkDependencies: mockCheckDeps,
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockWhichBwrap,
}));

const { detectKernelCapabilities, assertSandboxSupported } = await import("./detect.js");

describe("detectKernelCapabilities()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports bwrap available when which bwrap succeeds", () => {
    mockWhichBwrap.mockReturnValue("/usr/bin/bwrap");
    const caps = detectKernelCapabilities();
    expect(caps.bwrap.available).toBe(true);
    expect(caps.bwrap.path).toBe("/usr/bin/bwrap");
  });

  it("reports bwrap unavailable when which bwrap fails", () => {
    mockWhichBwrap.mockImplementation(() => { throw new Error("not found"); });
    const caps = detectKernelCapabilities();
    expect(caps.bwrap.available).toBe(false);
    expect(caps.bwrap.path).toBeUndefined();
  });
});

describe("assertSandboxSupported()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not throw when platform is supported and deps are OK", () => {
    mockIsSupportedPlatform.mockReturnValue(true);
    mockCheckDeps.mockReturnValue({ errors: [], warnings: [] });
    expect(() => assertSandboxSupported()).not.toThrow();
  });

  it("throws when platform is not supported", () => {
    mockIsSupportedPlatform.mockReturnValue(false);
    mockCheckDeps.mockReturnValue({ errors: [], warnings: [] });
    expect(() => assertSandboxSupported()).toThrow(/platform/i);
  });

  it("throws when sandbox-runtime deps are missing", () => {
    mockIsSupportedPlatform.mockReturnValue(true);
    mockCheckDeps.mockReturnValue({ errors: ["bubblewrap not found"], warnings: [] });
    expect(() => assertSandboxSupported()).toThrow(/bubblewrap not found/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/sandbox -- detect.test
```

Expected: FAIL — detect.ts doesn't use SandboxManager yet.

- [ ] **Step 3: Rewrite `packages/sandbox/src/detect.ts`**

All imports must be at the top of the file — ESM hoists them automatically but oxlint enforces `import/first` (zero lint diagnostics required).

```typescript
import { execFileSync, execFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { KernelCapabilities } from "./types.js";

/**
 * Probes system capabilities relevant to sandboxing.
 * Returns KernelCapabilities with bwrap probe on Linux; on macOS the
 * bwrap fields are always unavailable (macOS uses sandbox-exec instead).
 */
export function detectKernelCapabilities(): KernelCapabilities {
  let bwrapPath: string | undefined;
  let bwrapVersion: string | undefined;

  try {
    bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
    try {
      bwrapVersion = execFileSync("bwrap", ["--version"], { encoding: "utf8" })
        .trim()
        .split("\n")[0];
    } catch {
      // version flag not supported or bwrap not runnable — path is still valid
    }
  } catch {
    // bwrap not on PATH
  }

  // Landlock / seccomp / namespace detection is Linux-only; on macOS these
  // are undefined/false since sandbox-runtime uses sandbox-exec there.
  const isLinux = process.platform === "linux";

  return {
    landlock: {
      supported: isLinux ? detectLandlock() : false,
      abiVersion: isLinux ? detectLandlockAbi() : 0,
    },
    seccomp: { supported: isLinux ? detectSeccomp() : false },
    namespaces: {
      user: isLinux ? existsSync("/proc/self/ns/user") : false,
      pid:  isLinux ? existsSync("/proc/self/ns/pid")  : false,
      net:  isLinux ? existsSync("/proc/self/ns/net")  : false,
      mnt:  isLinux ? existsSync("/proc/self/ns/mnt")  : false,
    },
    bwrap: {
      available: bwrapPath !== undefined,
      path: bwrapPath,
      version: bwrapVersion,
    },
  };
}

/**
 * Throws a descriptive error if the current platform and dependencies
 * do not support sandbox-runtime isolation.
 */
export function assertSandboxSupported(): KernelCapabilities {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(
      `SafeClaw sandbox is not supported on this platform (${process.platform}). ` +
        `Supported: Linux (kernel ≥ 5.13, bubblewrap, socat, ripgrep) and macOS.`,
    );
  }

  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    throw new Error(
      `Sandbox dependencies missing: ${deps.errors.join(", ")}. ` +
        `On Linux install: apt install bubblewrap socat ripgrep`,
    );
  }

  return detectKernelCapabilities();
}

// ── Linux helpers ──────────────────────────────────────────────────────

const LANDLOCK_MIN_KERNEL: [number, number] = [5, 13];

function parseKernelVersion(release: string): [number, number] {
  const parts = release.trim().split(".");
  return [parseInt(parts[0] ?? "0", 10), parseInt(parts[1] ?? "0", 10)];
}

function detectLandlock(): boolean {
  try {
    const release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
    const [major, minor] = parseKernelVersion(release);
    return (
      major > LANDLOCK_MIN_KERNEL[0] ||
      (major === LANDLOCK_MIN_KERNEL[0] && minor >= LANDLOCK_MIN_KERNEL[1])
    );
  } catch {
    return false;
  }
}

function detectLandlockAbi(): number {
  try {
    const release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
    const [major, minor] = parseKernelVersion(release);
    if (major > 6 || (major === 6 && minor >= 2)) return 3;
    if (major > 5 || (major === 5 && minor >= 19)) return 2;
    if (major > 5 || (major === 5 && minor >= 13)) return 1;
    return 0;
  } catch {
    return 0;
  }
}

function detectSeccomp(): boolean {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    return /Seccomp:\s*[12]/.test(status);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter @safeclaw/sandbox -- detect.test
```

Expected: PASS.

- [ ] **Step 5: Run all sandbox tests**

```bash
pnpm test --filter @safeclaw/sandbox
```

Expected: PASS (previous tests still work).

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/src/detect.ts packages/sandbox/src/detect.test.ts
git commit -m "feat(sandbox): replace unshare detection with sandbox-runtime dependency checks"
```

---

### Task 5: Rewrite Sandbox.execute() to use SandboxManager

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts`
- Modify: `packages/sandbox/src/sandbox.test.ts`

Background: `Sandbox.execute()` currently spawns `unshare [flags] -- helper -- command`. We replace this with: `SandboxManager.wrapWithSandbox(shellCmd, undefined, rtConfig)` which returns a shell command string, then spawn via `/bin/sh -c`. The C helper integration (Landlock/cap-drop) is deferred to Task 8.

`SandboxManager.initialize()` **must be called** in `bootstrapAgent()` (Task 6) before constructing `Sandbox`. The `Sandbox` class verifies this at construction time.

Shell quoting: a POSIX single-quote escape avoids adding a new dependency.

- [ ] **Step 1: Write failing tests in `sandbox.test.ts`**

Replace the existing test file:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY } from "./types.js";
import type { KernelCapabilities } from "./types.js";

// Mock sandbox-runtime and helper before dynamic import
const mockAssertSandboxSupported = vi.fn<() => KernelCapabilities>();
const mockFindHelper = vi.fn<() => string | undefined>();
const mockWrapWithSandbox = vi.fn<(cmd: string) => Promise<string>>();
const mockIsSupportedPlatform = vi.fn<() => boolean>();
const mockIsSandboxingEnabled = vi.fn<() => boolean>();
const mockCleanupAfterCommand = vi.fn<() => void>();

vi.mock("./detect.js", () => ({
  assertSandboxSupported: mockAssertSandboxSupported,
}));

vi.mock("./helper.js", () => ({
  findHelper: () => mockFindHelper(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    isSupportedPlatform: mockIsSupportedPlatform,
    isSandboxingEnabled: mockIsSandboxingEnabled,
    wrapWithSandbox: mockWrapWithSandbox,
    cleanupAfterCommand: mockCleanupAfterCommand,
  },
}));

const { Sandbox } = await import("./sandbox.js");

const FULL_CAPS: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 3 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
  bwrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
};

describe("Sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockIsSandboxingEnabled.mockReturnValue(true);
    mockFindHelper.mockReturnValue(undefined);
  });

  it("constructor calls assertSandboxSupported", () => {
    new Sandbox(DEFAULT_POLICY);
    expect(mockAssertSandboxSupported).toHaveBeenCalledOnce();
  });

  it("constructor throws if not initialized (isSandboxingEnabled returns false)", () => {
    mockIsSandboxingEnabled.mockReturnValue(false);
    expect(() => new Sandbox(DEFAULT_POLICY)).toThrow(/initialize/i);
  });

  it("getPolicy returns a copy of the policy", () => {
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const policy = sandbox.getPolicy();
    expect(policy).toEqual(DEFAULT_POLICY);
    expect(policy).not.toBe(DEFAULT_POLICY);
  });
});

describe("Sandbox.execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockIsSandboxingEnabled.mockReturnValue(true);
    mockFindHelper.mockReturnValue(undefined);
  });

  it("calls wrapWithSandbox with shell-quoted command", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/echo hello");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/echo", ["hello"]);
    expect(mockWrapWithSandbox).toHaveBeenCalledOnce();
    const wrappedArg: string = mockWrapWithSandbox.mock.calls[0]![0]!;
    expect(wrappedArg).toContain("echo");
    expect(wrappedArg).toContain("hello");
  });

  it("calls cleanupAfterCommand after execution", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/true");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/true", []);
    expect(mockCleanupAfterCommand).toHaveBeenCalledOnce();
  });

  it("returns stdout and exitCode from the spawned command", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/echo hello");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("kills process after timeout and returns killReason=timeout", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/sleep 60");
    const policy = { ...DEFAULT_POLICY, timeoutMs: 100 };
    const sandbox = new Sandbox(policy);
    const result = await sandbox.execute("/bin/sleep", ["60"]);
    expect(result.killed).toBe(true);
    expect(result.killReason).toBe("timeout");
  });

  it("reports pivotRoot=true and bindMounts=true on Linux", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/true");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    // These are set based on platform; in CI (Linux) both should be true
    expect(typeof result.enforcement?.pivotRoot).toBe("boolean");
    expect(typeof result.enforcement?.bindMounts).toBe("boolean");
  });

  it("calls cleanupAfterCommand even when command fails", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/false");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/false", []);
    expect(mockCleanupAfterCommand).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/sandbox -- sandbox.test
```

Expected: FAIL.

- [ ] **Step 3: Rewrite `packages/sandbox/src/sandbox.ts`**

Note: remove the now-dead `buildUnshareFlags()` private method from the old code — it will trigger `no-unused-vars` under oxlint.

```typescript
import { spawn } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxPolicy, SandboxResult, EnforcementLayers } from "./types.js";
import { assertSandboxSupported } from "./detect.js";
import { PolicyBuilder } from "./policy-builder.js";

/** POSIX single-quote shell escaping. Safe for all byte values. */
function shEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    if (!SandboxManager.isSandboxingEnabled()) {
      throw new Error(
        "SandboxManager is not initialized. Call SandboxManager.initialize() " +
          "before constructing a Sandbox (see bootstrapAgent()).",
      );
    }
    this.policy = policy;
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const start = performance.now();
    const timeout = this.policy.timeoutMs ?? 30_000;

    // Build the inner shell command. In Phase 1 the helper is not injected;
    // Task 8 adds `--policy-file` injection for Landlock + cap-drop.
    const shellCmd = [command, ...args].map(shEscape).join(" ");

    // Translate SafeClaw policy to sandbox-runtime config
    const rtConfig = PolicyBuilder.toRuntimeConfig(this.policy);

    // Wrap via sandbox-runtime (bwrap on Linux, sandbox-exec on macOS)
    const wrappedCmd = await SandboxManager.wrapWithSandbox(
      shellCmd,
      undefined,
      rtConfig,
    );

    const isLinux = process.platform === "linux";
    const enforcement: EnforcementLayers = {
      namespaces: isLinux,
      pivotRoot: isLinux,
      bindMounts: true,
      landlock: false,   // Phase 2: re-enabled when helper is injected
      seccomp: isLinux,  // sandbox-runtime applies seccomp for unix socket blocking on Linux
      capDrop: false,    // Phase 2: re-enabled when helper is injected
    };

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn("/bin/sh", ["-c", wrappedCmd], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const timer = setTimeout(() => {
        killed = true;
        killReason = "timeout";
        if (proc.pid !== undefined) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        } else {
          proc.kill("SIGKILL");
        }
      }, timeout);

      proc.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        // Clean up bwrap leftover mount points (no-op on macOS)
        SandboxManager.cleanupAfterCommand();
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          durationMs: performance.now() - start,
          killed,
          killReason,
          enforcement,
        });
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        SandboxManager.cleanupAfterCommand();
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: err.message,
          durationMs: performance.now() - start,
          killed: false,
          enforcement,
        });
      });
    });
  }

  getPolicy(): SandboxPolicy {
    return structuredClone(this.policy);
  }
}
```

Note: the `findHelper` import is unused in Phase 1 — remove it to avoid lint errors. It will be re-added in Task 8.

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter @safeclaw/sandbox -- sandbox.test
```

Expected: PASS.

- [ ] **Step 5: Run all sandbox tests**

```bash
pnpm test --filter @safeclaw/sandbox
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/src/sandbox.ts packages/sandbox/src/sandbox.test.ts
git commit -m "feat(sandbox): rewrite Sandbox.execute() to use SandboxManager.wrapWithSandbox()"
```

---

### Task 6: Initialize SandboxManager in bootstrapAgent

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts`
- Modify: `packages/cli/src/commands/bootstrap.test.ts`

Background: `SandboxManager.initialize(config)` is async and starts the network proxy infrastructure (HTTP proxy, SOCKS5 proxy, socat Unix socket bridges on Linux). It must be called once before any `Sandbox` is constructed or `wrapWithSandbox()` is called. It also registers a process `exit`/`SIGINT`/`SIGTERM` handler for cleanup automatically.

The base config passed to `initialize()` sets up the proxy servers. Per-call `customConfig` in `wrapWithSandbox()` (passed from `PolicyBuilder.toRuntimeConfig()`) overrides filesystem and network restrictions per execution.

- [ ] **Step 1: Write failing test for SandboxManager initialization**

In `bootstrap.test.ts`, add a test that verifies `SandboxManager.initialize` was called:

```typescript
// At the top of the mock setup in bootstrap.test.ts, add:
const mockSandboxManagerInitialize = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockSandboxManagerIsSupportedPlatform = vi.fn<() => boolean>().mockReturnValue(true);
const mockSandboxManagerIsSandboxingEnabled = vi.fn<() => boolean>().mockReturnValue(true);

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: mockSandboxManagerInitialize,
    isSupportedPlatform: mockSandboxManagerIsSupportedPlatform,
    isSandboxingEnabled: mockSandboxManagerIsSandboxingEnabled,
    wrapWithSandbox: vi.fn().mockResolvedValue("/bin/true"),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
  },
}));

// Add test:
it("calls SandboxManager.initialize before constructing Sandbox", async () => {
  await bootstrapAgent(validDeps);
  expect(mockSandboxManagerInitialize).toHaveBeenCalledOnce();
  // initialize must be called before Sandbox is constructed
  // (verified by order — assertSandboxSupported mock checks isSandboxingEnabled)
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/cli -- bootstrap.test
```

Expected: FAIL — `SandboxManager.initialize` not called yet.

- [ ] **Step 3: Add `SandboxManager.initialize()` call to `bootstrapAgent()`**

In `bootstrap.ts`, add import:
```typescript
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
```

In `bootstrapAgent()`, before the `let sandbox: Sandbox | undefined` block (around line 185), add:

```typescript
// Initialize sandbox-runtime network proxy infrastructure.
// Uses a base "block all network" config; per-execution configs are passed
// as customConfig in Sandbox.execute() → SandboxManager.wrapWithSandbox().
try {
  await SandboxManager.initialize({
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  });
} catch (err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  output.write(
    `Warning: sandbox network proxy failed to initialize (${detail}). ` +
      `Filesystem isolation will still be applied.\n`,
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter @safeclaw/cli -- bootstrap.test
```

Expected: PASS.

- [ ] **Step 5: Run all CLI tests**

```bash
pnpm test --filter @safeclaw/cli
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/bootstrap.ts packages/cli/src/commands/bootstrap.test.ts
git commit -m "feat(cli): initialize SandboxManager network proxy before constructing Sandbox"
```

---

### Task 7: Update doctor checks

**Files:**
- Modify: `packages/cli/src/commands/doctor-checks.ts`
- Modify: `packages/cli/src/commands/doctor-checks.test.ts`
- Modify: `packages/cli/src/commands/doctor.ts`

Background: `unshareCheck` is replaced by `bwrapCheck`. Two new checks are added: `socatCheck` (Linux only; socat bridges proxy sockets into the bwrap network namespace) and `ripgrepCheck` (sandbox-runtime uses ripgrep to scan for dangerous files before each command). The `sandboxHelperCheck` remains but is downgraded to `warn` since the helper is now optional.

- [ ] **Step 1: Write failing tests for new checks**

Add to `doctor-checks.test.ts`:

```typescript
describe("bwrapCheck", () => {
  it("passes when bwrap is available", async () => {
    const check = bwrapCheck({ execFileSync: () => "/usr/bin/bwrap" });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/bwrap/);
  });

  it("fails when bwrap is not found", async () => {
    const check = bwrapCheck({ execFileSync: () => { throw new Error("not found"); } });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/apt install bubblewrap/);
  });
});

describe("socatCheck", () => {
  it("passes when socat is available on linux", async () => {
    const check = socatCheck({
      execFileSync: () => "/usr/bin/socat",
      platform: "linux",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("skips on macOS (socat not required)", async () => {
    const check = socatCheck({
      execFileSync: () => { throw new Error(); },
      platform: "darwin",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/not required/);
  });

  it("fails when socat is missing on linux", async () => {
    const check = socatCheck({
      execFileSync: () => { throw new Error("not found"); },
      platform: "linux",
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/apt install socat/);
  });
});

describe("ripgrepCheck", () => {
  it("passes when rg is available", async () => {
    const check = ripgrepCheck({ execFileSync: () => "/usr/bin/rg" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when rg is not found", async () => {
    const check = ripgrepCheck({ execFileSync: () => { throw new Error(); } });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/apt install ripgrep/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/cli -- doctor-checks.test
```

Expected: FAIL — `bwrapCheck`, `socatCheck`, `ripgrepCheck` not defined.

- [ ] **Step 3: Add checks to `doctor-checks.ts`**

Replace `unshareCheck` with `bwrapCheck`, and add `socatCheck` and `ripgrepCheck`:

```typescript
// Remove unshareCheck entirely, add:

export interface BwrapDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function bwrapCheck(
  deps: BwrapDeps = {
    execFileSync: (cmd, args) => defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "bwrap",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const path = deps.execFileSync("which", ["bwrap"]).trim();
        return { status: "pass", message: `bubblewrap: ${path}` };
      } catch {
        return {
          status: "fail",
          message: "bubblewrap not found",
          detail:
            "bubblewrap is required for filesystem isolation on Linux. " +
            "Install: apt install bubblewrap",
        };
      }
    },
  };
}

export interface SocatDeps {
  execFileSync: (cmd: string, args: string[]) => string;
  platform: string;
}

export function socatCheck(
  deps: SocatDeps = {
    execFileSync: (cmd, args) => defaultExecFileSync(cmd, args, { encoding: "utf8" }),
    platform: process.platform,
  },
): DiagnosticCheck {
  return {
    name: "socat",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      if (deps.platform !== "linux") {
        return { status: "pass", message: "socat not required on this platform" };
      }
      try {
        const path = deps.execFileSync("which", ["socat"]).trim();
        return { status: "pass", message: `socat: ${path}` };
      } catch {
        return {
          status: "fail",
          message: "socat not found",
          detail:
            "socat is required for network proxy bridging on Linux. " +
            "Install: apt install socat",
        };
      }
    },
  };
}

export interface RipgrepDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function ripgrepCheck(
  deps: RipgrepDeps = {
    execFileSync: (cmd, args) => defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "ripgrep",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const path = deps.execFileSync("which", ["rg"]).trim();
        return { status: "pass", message: `ripgrep: ${path}` };
      } catch {
        return {
          status: "fail",
          message: "ripgrep (rg) not found",
          detail:
            "ripgrep is required by sandbox-runtime to scan for dangerous files " +
            "before each sandboxed command. Install: apt install ripgrep",
        };
      }
    },
  };
}
```

Also update `sandboxHelperCheck` message — change `status: "warn"` detail to note the helper is optional (provides Landlock + cap-drop) rather than required:

```typescript
return {
  status: "warn",
  message: "Sandbox helper not found",
  detail:
    "The native sandbox helper binary is not installed. " +
    "Filesystem and network isolation via bubblewrap will still apply, " +
    "but Landlock and capability-dropping will be inactive. " +
    "Run 'make -C native' to build it.",
};
```

- [ ] **Step 4: Update `doctor.ts` check list**

Find where `unshareCheck` is registered and replace it. Also update `linuxCheck` — sandbox-runtime now supports macOS so the hard Linux requirement is gone. Replace `linuxCheck` with a `platformCheck` that passes on both `linux` and `darwin`:

```typescript
// In doctor-checks.ts, replace linuxCheck with:
export function platformCheck(
  deps: PlatformDeps = { platform: process.platform },
): DiagnosticCheck {
  return {
    name: "platform",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      if (deps.platform === "linux" || deps.platform === "darwin") {
        return { status: "pass", message: `Platform: ${deps.platform} (supported)` };
      }
      return {
        status: "fail",
        message: `Platform ${deps.platform} is not supported`,
        detail: "SafeClaw requires Linux or macOS.",
      };
    },
  };
}
```

In `doctor.ts`, swap:
```typescript
// Remove: linuxCheck()
// Remove: unshareCheck()
// Add:
platformCheck(),
bwrapCheck(),
socatCheck(),
ripgrepCheck(),
```

Export `platformCheck`, `bwrapCheck`, `socatCheck`, `ripgrepCheck` from `doctor-checks.ts`.

Add tests for `platformCheck`:
```typescript
describe("platformCheck", () => {
  it("passes on linux", async () => {
    const r = await platformCheck({ platform: "linux" }).run();
    expect(r.status).toBe("pass");
  });
  it("passes on darwin", async () => {
    const r = await platformCheck({ platform: "darwin" }).run();
    expect(r.status).toBe("pass");
  });
  it("fails on win32", async () => {
    const r = await platformCheck({ platform: "win32" }).run();
    expect(r.status).toBe("fail");
  });
});
```

- [ ] **Step 5: Run tests**

```bash
pnpm test --filter @safeclaw/cli -- doctor-checks.test
pnpm test --filter @safeclaw/cli -- doctor.test
```

Expected: PASS on both.

- [ ] **Step 6: Full build + test**

```bash
pnpm build && pnpm test
```

Expected: all tests pass, zero lint errors.

```bash
pnpm lint
```

Expected: zero diagnostics.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/doctor-checks.ts \
        packages/cli/src/commands/doctor-checks.test.ts \
        packages/cli/src/commands/doctor.ts
git commit -m "feat(cli): replace unshareCheck with bwrap/socat/ripgrep checks for sandbox-runtime"
```

---

## Phase 2 — C helper as inner Landlock + cap-drop layer

### Task 8: Inject C helper inside bwrap via --policy-file

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts`
- Modify: `packages/sandbox/src/sandbox.test.ts`

Background: The C helper at `native/safeclaw-sandbox-helper` already supports `--policy-file <path>`, which reads a policy JSON file instead of fd 3. The file must have mode `0600` and be owned by the current user (enforced by `policy_read_file()` in `policy.c`).

When the helper is present, the spawn chain becomes:
```
/bin/sh -c "bwrap [sandbox-runtime args] /bin/sh -c '<helper> --policy-file <tmp> -- <command> [args]'"
```

The helper binary and temp file directory (`/tmp`) must be accessible inside the bwrap container. `/tmp` is always bind-mounted by sandbox-runtime. The helper path (e.g. `/usr/local/bin/safeclaw-sandbox-helper` or `~/.safeclaw/bin/safeclaw-sandbox-helper`) must either be in a system path included by bwrap, or explicitly added to `allowWrite`.

- [ ] **Step 1: Write failing tests**

Add to `sandbox.test.ts`:

```typescript
describe("Sandbox.execute() with helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockIsSandboxingEnabled.mockReturnValue(true);
  });

  it("includes --policy-file in the inner command when helper is found", async () => {
    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");
    mockWrapWithSandbox.mockImplementation(async (cmd: string) => cmd);

    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/echo", ["hello"]);

    const innerCmd: string = mockWrapWithSandbox.mock.calls[0]![0]!;
    expect(innerCmd).toContain("safeclaw-sandbox-helper");
    expect(innerCmd).toContain("--policy-file");
    expect(innerCmd).toContain("--");
    expect(innerCmd).toContain("echo");
  });

  it("sets enforcement.landlock=true and enforcement.capDrop=true when helper is found", async () => {
    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");
    mockWrapWithSandbox.mockResolvedValue("/bin/true");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);

    expect(result.enforcement?.landlock).toBe(true);
    expect(result.enforcement?.capDrop).toBe(true);
  });

  it("does NOT set landlock/capDrop when helper is not found", async () => {
    mockFindHelper.mockReturnValue(undefined);
    mockWrapWithSandbox.mockResolvedValue("/bin/true");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);

    expect(result.enforcement?.landlock).toBe(false);
    expect(result.enforcement?.capDrop).toBe(false);
  });

  it("cleans up policy temp file even if command fails", async () => {
    // Mock node:fs so we can verify writeFileSync and rmSync are both called
    const mockWriteFileSync = vi.fn();
    const mockRmSync = vi.fn();
    vi.mock("node:fs", () => ({
      writeFileSync: mockWriteFileSync,
      rmSync: mockRmSync,
    }));

    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");
    mockWrapWithSandbox.mockResolvedValue("/bin/false");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/false", []);

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    // rmSync must be called with force:true to clean up the temp file
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("safeclaw-policy-"),
      { force: true },
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @safeclaw/sandbox -- sandbox.test
```

Expected: FAIL — helper injection not yet implemented.

- [ ] **Step 3: Add policy-file injection to `Sandbox.execute()`**

Update `packages/sandbox/src/sandbox.ts`. Add imports:

```typescript
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findHelper } from "./helper.js";
```

In `execute()`, replace the `shellCmd` / `wrappedCmd` section with:

```typescript
const helperPath = findHelper();
const useHelper = helperPath !== undefined;

let policyTmpPath: string | undefined;
let innerCmd: string;

if (useHelper) {
  // Write policy JSON to a temp file (mode 0600, as required by policy_read_file).
  // The helper enforces the permissions check itself — this is defense-in-depth.
  policyTmpPath = join(
    tmpdir(),
    `safeclaw-policy-${process.pid}-${Date.now()}.json`,
  );
  writeFileSync(
    policyTmpPath,
    JSON.stringify({
      filesystem: this.policy.filesystem,
      syscalls: this.policy.syscalls,
    }),
    { mode: 0o600 },
  );
  innerCmd = [
    helperPath,
    "--policy-file", policyTmpPath,
    "--",
    command,
    ...args,
  ]
    .map(shEscape)
    .join(" ");
} else {
  innerCmd = [command, ...args].map(shEscape).join(" ");
}

// Translate to sandbox-runtime config. When helper is present, add its
// directory to allowWrite so bwrap bind-mounts it into the container.
const rtConfig = PolicyBuilder.toRuntimeConfig(this.policy);
if (useHelper && helperPath !== undefined) {
  const helperDir = helperPath.substring(0, helperPath.lastIndexOf("/"));
  // Only add if not already a system path (system paths are included by bwrap automatically)
  const systemPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];
  if (!systemPaths.includes(helperDir)) {
    rtConfig.filesystem.allowWrite = [
      ...rtConfig.filesystem.allowWrite,
      helperDir,
    ];
  }
}

const wrappedCmd = await SandboxManager.wrapWithSandbox(innerCmd, undefined, rtConfig);
```

Update `enforcement` to reflect helper presence:

```typescript
const enforcement: EnforcementLayers = {
  namespaces: isLinux,
  pivotRoot: isLinux,
  bindMounts: true,
  landlock: useHelper,
  seccomp: isLinux,
  capDrop: useHelper,
};
```

Add cleanup of `policyTmpPath` in both `close` and `error` handlers:

```typescript
proc.on("close", (code: number | null) => {
  clearTimeout(timer);
  if (policyTmpPath !== undefined) {
    try { rmSync(policyTmpPath, { force: true }); } catch { /* ignore */ }
  }
  SandboxManager.cleanupAfterCommand();
  resolve({ ... });
});

proc.on("error", (err: Error) => {
  clearTimeout(timer);
  if (policyTmpPath !== undefined) {
    try { rmSync(policyTmpPath, { force: true }); } catch { /* ignore */ }
  }
  SandboxManager.cleanupAfterCommand();
  resolve({ ... });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter @safeclaw/sandbox -- sandbox.test
```

Expected: PASS.

- [ ] **Step 5: Full build + test + lint**

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: all pass, zero lint diagnostics.

- [ ] **Step 6: Integration smoke test (requires bwrap + helper on PATH)**

```bash
# Build helper first if needed
make -C native

# Run a simple sandboxed command
node -e "
import('@safeclaw/sandbox').then(async ({ Sandbox, PolicyBuilder, SandboxManager }) => {
  await SandboxManager.initialize({ filesystem: { allowWrite: [], denyWrite: [], denyRead: [] }, network: { allowedDomains: [], deniedDomains: [] }});
  const sandbox = new Sandbox(PolicyBuilder.forDevelopment(process.cwd()));
  const result = await sandbox.execute('/bin/echo', ['hello from sandbox']);
  console.log(result);
  await SandboxManager.reset();
});
"
```

Expected: `{ exitCode: 0, stdout: 'hello from sandbox\n', enforcement: { landlock: true, capDrop: true, ... } }`.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/src/sandbox.ts packages/sandbox/src/sandbox.test.ts
git commit -m "feat(sandbox): inject C helper via --policy-file for Landlock + cap-drop inside bwrap"
```

---

## Risks and Notes

| Risk | Mitigation |
|------|-----------|
| `SandboxManager.initialize()` called before `Sandbox` constructor | Enforced: `Sandbox` constructor checks `isSandboxingEnabled()` and throws with clear message |
| Policy temp file leaked if process crashes between `writeFile` and `rmSync` | Temp file lives in `/tmp` — OS cleans it on reboot. Filename includes PID so post-mortem identification is possible |
| Helper binary not accessible inside bwrap when in non-system path | Task 8 adds `helperDir` to `allowWrite`; the `systemPaths` exclusion list may need extension for unusual installs |
| sandbox-runtime v0.0.42 is pre-stable | Pinned to exact git SHA `20f5176`. Check for updates before shipping. |
| `wrapWithSandbox()` may fail if proxy not initialized | The `catch` block in `bootstrapAgent()` catches init failures; filesystem isolation still applies |
| macOS: `sandbox-exec` behavior differs from bwrap | Tested by sandbox-runtime; our `PolicyBuilder.toRuntimeConfig()` translation is platform-agnostic |
| Seccomp conflict: sandbox-runtime installs unix-socket BPF, helper installs its own syscall filter | Both apply inside the process. sandbox-runtime's filter applies first (outer bwrap layer); helper's filter applies inside. Filters stack (both must allow a syscall for it to proceed). Verify the helper's syscall allowlist includes all syscalls needed by sandbox-runtime's filter management |
| `process.kill(-proc.pid, 'SIGKILL')` on timeout may not reach bwrap's children | The outer `/bin/sh` is the process group leader (`detached: true`). bwrap inherits the group, and sandboxed children inherit from bwrap. Verify with `execute('/bin/sleep', ['60'])` + short timeout — if `result.killed === true` the group kill worked. Add an integration test for this. |
| Helper binary not bind-mounted into bwrap when in non-system path | Task 8 adds `helperDir` to `rtConfig.filesystem.allowWrite`. sandbox-runtime maps `allowWrite` paths to `--bind` (read+write), which also allows execute on Linux. If the helper is in a non-standard location (e.g. `~/.safeclaw/bin/`), verify it is executable inside the bwrap container by running the integration smoke test with `SAFECLAW_HELPER_PATH=~/.safeclaw/bin/safeclaw-sandbox-helper`. |
