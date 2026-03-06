# Bubblewrap Sandbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `unshare(1)` with bubblewrap (`bwrap`) as the outer container layer, adding `pivot_root` filesystem isolation while keeping the C helper for Landlock + seccomp + cap drop as an inner layer.

**Architecture:** Two-layer sandbox: bwrap creates an isolated filesystem root via `pivot_root` + selective bind mounts + namespace isolation (outer), the existing C helper applies Landlock + seccomp-BPF + capability drop (inner). Spawn chain: `bwrap [flags] -- helper -- command [args]`.

**Tech Stack:** TypeScript (ES2024, strict), Vitest 4.x, bubblewrap (system package), existing C11 helper binary.

---

### Task 1: Extend type definitions in types.ts

**Files:**
- Modify: `packages/sandbox/src/types.ts:17-22` (EnforcementLayers)
- Modify: `packages/sandbox/src/types.ts:36-40` (KernelCapabilities)

**Step 1: Write the failing test**

Add tests to `packages/sandbox/src/detect.test.ts` that expect the new fields. Insert at the end of the `describe("detectKernelCapabilities"` block (after line 114):

```typescript
  it("includes bwrap field in capabilities", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    const caps = detectKernelCapabilities();
    expect(caps.bwrap).toBeDefined();
    expect(caps.bwrap).toHaveProperty("available");
    expect(caps.bwrap).toHaveProperty("path");
    expect(caps.bwrap).toHaveProperty("version");
  });
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/sandbox/src/detect.test.ts --reporter=verbose`
Expected: FAIL — `bwrap` property does not exist on `KernelCapabilities`.

**Step 3: Extend `EnforcementLayers` with new fields**

In `packages/sandbox/src/types.ts`, replace lines 17-22:

```typescript
/** Which enforcement layers were active during execution */
export interface EnforcementLayers {
  namespaces: boolean;
  pivotRoot: boolean;
  bindMounts: boolean;
  landlock: boolean;
  seccomp: boolean;
  capDrop: boolean;
}
```

**Step 4: Extend `KernelCapabilities` with bwrap field**

In `packages/sandbox/src/types.ts`, replace lines 36-40:

```typescript
/** Kernel feature availability */
export interface KernelCapabilities {
  landlock: { supported: boolean; abiVersion: number };
  seccomp: { supported: boolean };
  namespaces: { user: boolean; pid: boolean; net: boolean; mnt: boolean };
  bwrap: { available: boolean; path: string | undefined; version: string | undefined };
}
```

**Step 5: Fix all compile errors from the new `EnforcementLayers` fields**

The new `pivotRoot` and `bindMounts` fields will cause compile errors in:
- `packages/sandbox/src/sandbox.ts:32-37` — add `pivotRoot` and `bindMounts` to the enforcement object
- `packages/sandbox/src/sandbox.test.ts` — update enforcement assertions
- `packages/sandbox/src/integration.test.ts` — update enforcement assertions
- `test/security/sandbox-escape.test.ts` — update enforcement assertions

For sandbox.ts (lines 32-37), change the enforcement object to:

```typescript
    const enforcement: EnforcementLayers = {
      namespaces: useUnshare,
      pivotRoot: false,
      bindMounts: false,
      landlock: useHelper,
      seccomp: useHelper,
      capDrop: useHelper,
    };
```

For sandbox.test.ts, update the enforcement assertions at lines 185-188 and 201-204 to include the new fields. For example at line 185:

```typescript
      expect(result.enforcement!.namespaces).toBe(true);
      expect(result.enforcement!.pivotRoot).toBe(false);
      expect(result.enforcement!.bindMounts).toBe(false);
      expect(result.enforcement!.landlock).toBe(false);
      expect(result.enforcement!.seccomp).toBe(false);
      expect(result.enforcement!.capDrop).toBe(false);
```

And at line 201 (full enforcement):

```typescript
      expect(result.enforcement!.namespaces).toBe(true);
      expect(result.enforcement!.pivotRoot).toBe(false);
      expect(result.enforcement!.bindMounts).toBe(false);
      expect(result.enforcement!.landlock).toBe(true);
      expect(result.enforcement!.seccomp).toBe(true);
      expect(result.enforcement!.capDrop).toBe(true);
```

For integration.test.ts, update assertion at line 131 (if it checks specific enforcement fields).

Fix the `FULL_CAPS` constant in sandbox.test.ts (line 34-38), sandbox-escape.test.ts (line 27-31), and integration.test.ts to include the new `bwrap` field:

```typescript
const FULL_CAPS: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 3 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
  bwrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
};
```

Also update `UNSUPPORTED_CAPS` in sandbox-escape.test.ts (line 21-25):

```typescript
const UNSUPPORTED_CAPS: KernelCapabilities = {
  landlock: { supported: false, abiVersion: 0 },
  seccomp: { supported: false },
  namespaces: { user: false, pid: false, net: false, mnt: false },
  bwrap: { available: false, path: undefined, version: undefined },
};
```

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/sandbox/src/ --reporter=verbose`
Expected: All existing tests pass (the new detect test will still fail — that's expected, we fix it in Task 2).

**Step 7: Commit**

```
git add -A && git commit -m "feat(sandbox): extend EnforcementLayers and KernelCapabilities types for bwrap"
```

---

### Task 2: Add bwrap detection to detect.ts and helper.ts

**Files:**
- Modify: `packages/sandbox/src/detect.ts:16-41` (detectKernelCapabilities)
- Modify: `packages/sandbox/src/detect.ts:43-58` (assertSandboxSupported)
- Modify: `packages/sandbox/src/helper.ts` (add findBwrap export)
- Modify: `packages/sandbox/src/index.ts` (export findBwrap)
- Modify: `packages/sandbox/src/detect.test.ts` (add bwrap detection tests)

**Step 1: Write the failing tests**

Add to `packages/sandbox/src/detect.test.ts`. We need to mock `execFileSync` for bwrap detection. Update the mock setup at the top of the file. The current mock only mocks `node:fs`, but `detectKernelCapabilities` will now call `execFileSync` to find bwrap. Add the mock:

```typescript
vi.mock("node:child_process");
const mockedChild = vi.mocked(await import("node:child_process"));
```

Update the `mockKernel` function to also set up bwrap mock behavior:

```typescript
function mockKernel(
  release: string,
  status: string,
  nsFiles: string[],
  bwrap?: { which?: string; version?: string },
): void {
  mockedFs.readFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
    if (path === "/proc/sys/kernel/osrelease") return release;
    if (path === "/proc/self/status") return status;
    throw new Error(`Unexpected readFileSync: ${String(path)}`);
  });
  mockedFs.existsSync.mockImplementation((path: fs.PathLike) =>
    nsFiles.includes(String(path)),
  );
  mockedChild.execFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
    if (cmd === "which" && args?.[0] === "bwrap") {
      if (bwrap?.which) return bwrap.which;
      throw new Error("not found");
    }
    if (cmd === "bwrap" && args?.[0] === "--version") {
      if (bwrap?.version) return bwrap.version;
      throw new Error("not found");
    }
    throw new Error(`Unexpected execFileSync: ${cmd}`);
  });
}
```

Update all existing `mockKernel` calls (they have 3 args) to work unchanged — make `bwrap` parameter optional (it already is with `?`). Existing tests pass `undefined` implicitly.

Add new test cases inside the `describe("detectKernelCapabilities"` block:

```typescript
  it("detects bwrap when available", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ], { which: "/usr/bin/bwrap\n", version: "bubblewrap 0.9.0\n" });

    const caps = detectKernelCapabilities();
    expect(caps.bwrap.available).toBe(true);
    expect(caps.bwrap.path).toBe("/usr/bin/bwrap");
    expect(caps.bwrap.version).toBe("0.9.0");
  });

  it("reports bwrap unavailable when not installed", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    const caps = detectKernelCapabilities();
    expect(caps.bwrap.available).toBe(false);
    expect(caps.bwrap.path).toBeUndefined();
    expect(caps.bwrap.version).toBeUndefined();
  });
```

Add a test in `describe("assertSandboxSupported"`:

```typescript
  it("throws when bwrap is not available", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    expect(() => assertSandboxSupported()).toThrow(/bubblewrap/);
  });
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/sandbox/src/detect.test.ts --reporter=verbose`
Expected: FAIL — bwrap field missing, assertSandboxSupported doesn't check bwrap.

**Step 3: Add `findBwrap()` to helper.ts**

Add at the end of `packages/sandbox/src/helper.ts` (after line 65):

```typescript
export function findBwrap(): string {
  // 1. Environment variable override
  const envPath = process.env["SAFECLAW_BWRAP_PATH"];
  if (envPath !== undefined && isExecutable(envPath)) {
    return envPath;
  }

  // 2. System PATH via `which`
  try {
    const result = execFileSync("which", ["bwrap"], { encoding: "utf8" });
    const whichPath = result.trim();
    if (whichPath.length > 0 && isExecutable(whichPath)) {
      return whichPath;
    }
  } catch {
    // not found on PATH
  }

  throw new Error(
    "bubblewrap (bwrap) not found. SafeClaw requires bubblewrap for sandbox isolation. " +
    "Install: apt install bubblewrap (Debian/Ubuntu) or dnf install bubblewrap (Fedora)",
  );
}
```

**Step 4: Update `detectKernelCapabilities()` in detect.ts**

Add import at top of `packages/sandbox/src/detect.ts`:

```typescript
import { execFileSync } from "node:child_process";
```

Add bwrap detection function (before `detectKernelCapabilities`):

```typescript
function detectBwrap(): { available: boolean; path: string | undefined; version: string | undefined } {
  try {
    const whichResult = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
    if (whichResult.length === 0) {
      return { available: false, path: undefined, version: undefined };
    }
    let version: string | undefined;
    try {
      const versionOutput = execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim();
      // Output is like "bubblewrap 0.9.0"
      const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
      version = match?.[1];
    } catch {
      // bwrap exists but --version failed; still available
    }
    return { available: true, path: whichResult, version };
  } catch {
    return { available: false, path: undefined, version: undefined };
  }
}
```

Add `bwrap: detectBwrap(),` to the return object of `detectKernelCapabilities()` (after line 39, before the closing brace).

**Step 5: Update `assertSandboxSupported()` in detect.ts**

Add bwrap check after the existing `namespaces.pid` check (after line 50):

```typescript
  if (!caps.bwrap.available)
    missing.push("bubblewrap (install: apt install bubblewrap)");
```

**Step 6: Export `findBwrap` from index.ts**

In `packages/sandbox/src/index.ts`, update the helper.js import line (line 14):

```typescript
export { findHelper, findBwrap } from "./helper.js";
```

**Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/sandbox/src/detect.test.ts --reporter=verbose`
Expected: PASS

**Step 8: Commit**

```
git add -A && git commit -m "feat(sandbox): add bwrap detection and make it a mandatory dependency"
```

---

### Task 3: Extend DevelopmentPolicyOptions and add selective home dirs

**Files:**
- Modify: `packages/sandbox/src/policy-builder.ts:6-11` (DevelopmentPolicyOptions)
- Modify: `packages/sandbox/src/policy-builder.ts:79-160` (forDevelopment)
- Test: `packages/sandbox/src/policy-builder.test.ts`

**Step 1: Write failing tests for new options and selective home dirs**

Add to `packages/sandbox/src/policy-builder.test.ts`. First, add tests inside the `describe("forDevelopment()"` block (after line 299, before the closing brace of `forDevelopment()`):

```typescript
    it("does NOT include full homedir as read-only", () => {
      const homeRule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === homedir(),
      );
      expect(homeRule).toBeUndefined();
    });

    it("includes safe home dotdirs as read-only", () => {
      // These should be present if they exist on disk
      const home = homedir();
      const safeDirs = [".config", ".cache", ".npm", ".gitconfig"];
      for (const dir of safeDirs) {
        const fullPath = `${home}/${dir}`;
        // We can only test dirs that exist on this machine
        const { existsSync } = await import("node:fs");
        if (existsSync(fullPath)) {
          const rule = policy.filesystem.allow.find(
            (r: PathRule) => r.path === fullPath,
          );
          expect(rule, `expected ${fullPath} to be in allow list`).toBeDefined();
          expect(rule!.access).toBe("read");
        }
      }
    });

    it("does NOT include sensitive home dirs", () => {
      const home = homedir();
      const sensitiveDirs = [".ssh", ".aws", ".gnupg", ".kube", ".docker"];
      for (const dir of sensitiveDirs) {
        const rule = policy.filesystem.allow.find(
          (r: PathRule) => r.path === `${home}/${dir}`,
        );
        expect(rule, `${dir} should not be in allow list`).toBeUndefined();
      }
    });
```

NOTE: The existing test `"includes home directory as read-only"` at line 195-201 will need to be **removed or updated** since we're no longer adding the full homedir.

Add tests for the new options inside `describe("forDevelopment() with user toolchains"`:

```typescript
    it("includes extra read-only paths", () => {
      const policy = PolicyBuilder.forDevelopment("/home/dev/project", {
        extraReadOnlyPaths: ["/opt/custom-sdk"],
      });
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/opt/custom-sdk",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("read");
    });

    it("includes extra home dirs as read-only", () => {
      const policy = PolicyBuilder.forDevelopment("/home/dev/project", {
        extraHomeDirs: [".cargo"],
      });
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === `${homedir()}/.cargo`,
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("read");
    });
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/sandbox/src/policy-builder.test.ts --reporter=verbose`
Expected: FAIL — homedir is still added as full read-only, new options not supported.

**Step 3: Extend `DevelopmentPolicyOptions`**

In `packages/sandbox/src/policy-builder.ts`, replace lines 6-11:

```typescript
/** Options for customizing the development policy */
export interface DevelopmentPolicyOptions {
  /** Additional paths that need execute access (e.g. ~/.cargo, ~/.rustup) */
  extraExecutePaths?: string[];
  /** Additional paths that need readwrite access (e.g. ~/.cache) */
  extraReadWritePaths?: string[];
  /** Additional paths that need read-only access */
  extraReadOnlyPaths?: string[];
  /** Additional safe home dotdirs to bind-mount read-only (e.g. ".cargo") */
  extraHomeDirs?: string[];
}
```

**Step 4: Replace full homedir with selective dotdir binding**

In `packages/sandbox/src/policy-builder.ts`, add `existsSync` import at line 1:

```typescript
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
```

Replace lines 120-123 (the homedir section) with:

```typescript
    // ── Selective home directory binding ──────────────────────────────
    // Only bind-mount specific safe dotdirs, NOT the full home directory.
    // Sensitive dirs like ~/.ssh, ~/.aws, ~/.gnupg are structurally absent.
    const home = homedir();
    const SAFE_HOME_DIRS: readonly string[] = [
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
    for (const dir of SAFE_HOME_DIRS) {
      const fullPath = join(home, dir);
      if (existsSync(fullPath)) {
        builder.addReadOnly(fullPath);
      }
    }
    if (options?.extraHomeDirs) {
      for (const dir of options.extraHomeDirs) {
        const fullPath = join(home, dir);
        builder.addReadOnly(fullPath);
      }
    }
```

Add handling for `extraReadOnlyPaths` after `extraReadWritePaths` (after line 151):

```typescript
    if (options?.extraReadOnlyPaths) {
      for (const p of options.extraReadOnlyPaths) {
        builder.addReadOnly(p);
      }
    }
```

**Step 5: Remove the old test for full homedir and update**

In `packages/sandbox/src/policy-builder.test.ts`, remove or replace the test at line 195-201 (`"includes home directory as read-only"`).

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/sandbox/src/policy-builder.test.ts --reporter=verbose`
Expected: PASS

**Step 7: Commit**

```
git add -A && git commit -m "feat(sandbox): selective home dotdir binding, hide sensitive dirs"
```

---

### Task 4: Change `forDevelopment()` return type and add `toBwrapArgs()`

**Files:**
- Modify: `packages/sandbox/src/policy-builder.ts:79-160` (forDevelopment return type)
- Modify: `packages/sandbox/src/policy-builder.ts` (add toBwrapArgs method)
- Modify: `packages/sandbox/src/policy-builder.test.ts` (update forDevelopment tests)
- Modify: `packages/cli/src/commands/bootstrap.ts:173` (update call site)

**Step 1: Write failing tests for `toBwrapArgs()`**

Add a new describe block at the end of `packages/sandbox/src/policy-builder.test.ts`:

```typescript
describe("PolicyBuilder.toBwrapArgs()", () => {
  it("generates --ro-bind for read-only paths", () => {
    const builder = new PolicyBuilder().addReadOnly("/etc");
    const args = builder.toBwrapArgs();
    expect(args).toContain("--ro-bind");
    const idx = args.indexOf("--ro-bind");
    expect(args[idx + 1]).toBe("/etc");
    expect(args[idx + 2]).toBe("/etc");
  });

  it("generates --bind for readwrite paths", () => {
    const builder = new PolicyBuilder().addReadWrite("/home/dev/project");
    const args = builder.toBwrapArgs();
    expect(args).toContain("--bind");
    const idx = args.indexOf("--bind");
    expect(args[idx + 1]).toBe("/home/dev/project");
    expect(args[idx + 2]).toBe("/home/dev/project");
  });

  it("generates --bind for readwriteexecute paths", () => {
    const builder = new PolicyBuilder().addReadWriteExecute("/home/dev/project");
    const args = builder.toBwrapArgs();
    expect(args).toContain("--bind");
    const idx = args.indexOf("--bind");
    expect(args[idx + 1]).toBe("/home/dev/project");
    expect(args[idx + 2]).toBe("/home/dev/project");
  });

  it("generates --ro-bind for execute paths", () => {
    const builder = new PolicyBuilder().addReadExecute("/usr/bin");
    const args = builder.toBwrapArgs();
    expect(args).toContain("--ro-bind");
    const idx = args.indexOf("--ro-bind");
    expect(args[idx + 1]).toBe("/usr/bin");
    expect(args[idx + 2]).toBe("/usr/bin");
  });

  it("includes base namespace and isolation flags", () => {
    const args = new PolicyBuilder().toBwrapArgs();
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--unshare-ipc");
    expect(args).toContain("--unshare-uts");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
  });

  it("includes --dev /dev, --proc /proc, --tmpfs /tmp", () => {
    const args = new PolicyBuilder().toBwrapArgs();
    const devIdx = args.indexOf("--dev");
    expect(devIdx).toBeGreaterThanOrEqual(0);
    expect(args[devIdx + 1]).toBe("/dev");

    const procIdx = args.indexOf("--proc");
    expect(procIdx).toBeGreaterThanOrEqual(0);
    expect(args[procIdx + 1]).toBe("/proc");

    const tmpIdx = args.indexOf("--tmpfs");
    expect(tmpIdx).toBeGreaterThanOrEqual(0);
    expect(args[tmpIdx + 1]).toBe("/tmp");
  });

  it("skips /tmp, /dev/*, /proc/* from bind mounts (handled by base flags)", () => {
    const builder = new PolicyBuilder()
      .addReadWrite("/tmp")
      .addReadWrite("/dev/null")
      .addReadOnly("/dev/urandom")
      .addReadOnly("/proc/self");
    const args = builder.toBwrapArgs();
    // These should NOT appear as --bind or --ro-bind targets
    const bindArgs = args.filter((a, i) =>
      (a === "--bind" || a === "--ro-bind") && (args[i + 1] === "/tmp" || args[i + 1]?.startsWith("/dev/") || args[i + 1]?.startsWith("/proc/")),
    );
    expect(bindArgs).toHaveLength(0);
  });

  it("includes helper path as --ro-bind when provided", () => {
    const args = new PolicyBuilder().toBwrapArgs("/opt/helper");
    expect(args).toContain("--ro-bind");
    const idx = args.lastIndexOf("--ro-bind");
    // Find the helper bind
    let found = false;
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === "--ro-bind" && args[i + 1] === "/opt/helper") {
        found = true;
        expect(args[i + 2]).toBe("/opt/helper");
      }
    }
    expect(found).toBe(true);
  });
});

describe("PolicyBuilder.forDevelopment() returns PolicyBuilder", () => {
  it("returns a PolicyBuilder instance", () => {
    const result = PolicyBuilder.forDevelopment("/home/dev/project");
    expect(result).toBeInstanceOf(PolicyBuilder);
  });

  it("can call build() on the result", () => {
    const builder = PolicyBuilder.forDevelopment("/home/dev/project");
    const policy = builder.build();
    expect(policy.filesystem).toBeDefined();
    expect(policy.syscalls).toBeDefined();
  });

  it("can call toBwrapArgs() on the result", () => {
    const builder = PolicyBuilder.forDevelopment("/home/dev/project");
    const args = builder.toBwrapArgs();
    expect(args.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/sandbox/src/policy-builder.test.ts --reporter=verbose`
Expected: FAIL — `toBwrapArgs` does not exist, `forDevelopment` returns `SandboxPolicy` not `PolicyBuilder`.

**Step 3: Add `toBwrapArgs()` method to PolicyBuilder**

In `packages/sandbox/src/policy-builder.ts`, add before the `build()` method (before line 51):

```typescript
  /**
   * Generates bwrap command-line arguments from the policy's path rules.
   *
   * Base flags: namespace isolation, die-with-parent, new-session,
   * synthetic /dev, /proc, /tmp.
   *
   * Each PathRule is translated to a bind-mount argument:
   * - read/execute -> --ro-bind path path
   * - write/readwrite/readwriteexecute -> --bind path path
   *
   * Paths handled natively by bwrap base flags (/tmp, /dev/*, /proc/*)
   * are excluded from bind-mount generation.
   *
   * @param helperPath - If provided, the helper binary is bind-mounted read-only
   */
  toBwrapArgs(helperPath?: string): string[] {
    const args: string[] = [
      // Namespace isolation
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      // Safety
      "--die-with-parent",
      "--new-session",
      // Synthetic filesystems
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
    ];

    // Paths handled by bwrap's synthetic mounts — skip from bind-mount generation
    const SKIP_PREFIXES = ["/tmp", "/dev/", "/dev", "/proc/", "/proc"];

    for (const rule of this.allowRules) {
      const shouldSkip = SKIP_PREFIXES.some(
        (prefix) => rule.path === prefix || rule.path.startsWith(prefix + "/"),
      );
      if (shouldSkip) continue;

      const flag = rule.access === "readwrite" || rule.access === "write" || rule.access === "readwriteexecute"
        ? "--bind"
        : "--ro-bind";
      args.push(flag, rule.path, rule.path);
    }

    // Bind-mount the helper binary read-only so it's accessible inside the sandbox
    if (helperPath !== undefined) {
      args.push("--ro-bind", helperPath, helperPath);
    }

    return args;
  }
```

**Step 4: Change `forDevelopment()` return type**

In `packages/sandbox/src/policy-builder.ts`, change the `forDevelopment` method signature and return:

Change line 82 from:
```typescript
  ): SandboxPolicy {
```
to:
```typescript
  ): PolicyBuilder {
```

Change line 159 from:
```typescript
    return builder.build();
```
to:
```typescript
    return builder;
```

**Step 5: Fix all call sites that use `forDevelopment()`**

In `packages/sandbox/src/policy-builder.test.ts`, update the `beforeEach` at line 75-77:

```typescript
    beforeEach(() => {
      policy = PolicyBuilder.forDevelopment("/home/dev/project").build();
    });
```

Update all other `PolicyBuilder.forDevelopment(...)` calls in the test file that expect a `SandboxPolicy` to append `.build()`:

- Line 305: `PolicyBuilder.forDevelopment("/home/dev/project", { extraExecutePaths: ... }).build()`
- Line 316: `PolicyBuilder.forDevelopment("/home/dev/project", { extraExecutePaths: ... }).build()`
- Line 327: `PolicyBuilder.forDevelopment("/home/dev/project", { extraReadWritePaths: ... }).build()`
- Line 338: `PolicyBuilder.forDevelopment("/home/dev/project", { extraExecutePaths: ... }).build()`

In `packages/cli/src/commands/bootstrap.ts`, update line 173:

```typescript
  const builder = PolicyBuilder.forDevelopment(process.cwd());
  const sandboxPolicy = builder.build();
```

The `allowedCommandPaths` extraction at line 174-176 stays the same but now uses `sandboxPolicy` (which it already does).

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/sandbox/src/policy-builder.test.ts --reporter=verbose`
Expected: PASS

Run: `pnpm typecheck` to verify no compile errors across the project.

**Step 7: Commit**

```
git add -A && git commit -m "feat(sandbox): add toBwrapArgs() method and change forDevelopment() to return PolicyBuilder"
```

---

### Task 5: Rewrite Sandbox class to use bwrap

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts` (complete rewrite of execute and constructor)
- Modify: `packages/sandbox/src/sandbox.test.ts` (update spawn chain tests)
- Modify: `packages/cli/src/commands/bootstrap.ts` (pass bwrapArgs to Sandbox)

**Step 1: Write failing tests for bwrap-based Sandbox**

Update `packages/sandbox/src/sandbox.test.ts`. The constructor now takes `(policy, bwrapArgs)`:

Replace the constructor test at line 46-52:

```typescript
  it("constructor calls assertSandboxSupported", () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);

    new Sandbox(DEFAULT_POLICY, ["--unshare-pid"]);

    expect(mockAssertSandboxSupported).toHaveBeenCalledOnce();
  });

  it("constructor throws if sandbox not supported", () => {
    mockAssertSandboxSupported.mockImplementation(() => {
      throw new Error("Missing kernel features: Landlock");
    });

    expect(() => new Sandbox(DEFAULT_POLICY, ["--unshare-pid"])).toThrow(
      /Missing kernel features/,
    );
  });

  it("getPolicy returns a copy of the policy", () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);

    const sandbox = new Sandbox(DEFAULT_POLICY, ["--unshare-pid"]);
    const policy = sandbox.getPolicy();

    expect(policy).toEqual(DEFAULT_POLICY);
    expect(policy).not.toBe(DEFAULT_POLICY);
  });
```

Add a mock for `findBwrap` alongside the existing `findHelper` mock. Update the mock setup:

```typescript
const mockFindBwrap = vi.fn<() => string>();

vi.mock("./helper.js", () => ({
  findHelper: () => mockFindHelper(),
  findBwrap: () => mockFindBwrap(),
}));
```

Wait — actually the Sandbox constructor takes `bwrapArgs` as a parameter now, and calls `findBwrap()` internally. Let me reconsider. Per the design doc, the constructor:

```typescript
constructor(policy: SandboxPolicy, bwrapArgs: string[]) {
    assertSandboxSupported();
    this.policy = policy;
    this.bwrapPath = findBwrap();   // throws if not found
    this.bwrapArgs = bwrapArgs;
    this.helperPath = findHelper();
}
```

So we need to mock both `findBwrap` and `findHelper`. Update the mock:

```typescript
const mockFindBwrap = vi.fn<() => string>();

vi.mock("./helper.js", () => ({
  findHelper: () => mockFindHelper(),
  findBwrap: () => mockFindBwrap(),
}));
```

And in `beforeEach`:

```typescript
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindHelper.mockReturnValue(undefined);
    mockFindBwrap.mockReturnValue("/usr/bin/bwrap");
  });
```

Update execute tests to pass bwrapArgs:

```typescript
  it.skipIf(!canUnshareUser)(
    "runs a command and returns stdout",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      const sandbox = new Sandbox(DEFAULT_POLICY, ["--unshare-pid", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]);
      // ... rest unchanged
    },
  );
```

Actually, since the sandbox now uses bwrap instead of unshare, the runtime behavior test needs bwrap to actually be present. The `canUnshareUser` guard may need to become a `canBwrap` guard. Update the probe at the top:

```typescript
let canBwrap = false;
try {
  execFileSync("bwrap", ["--unshare-pid", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", "/bin/true"], {
    timeout: 3000,
  });
  canBwrap = true;
} catch {
  // bwrap not available — skip dependent tests
}
```

Replace all `canUnshareUser` with `canBwrap` in the skip conditions.

Add a new test verifying enforcement metadata includes pivotRoot and bindMounts:

```typescript
  it.skipIf(!canBwrap)(
    "sets enforcement.pivotRoot and bindMounts when bwrap is used",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      mockFindBwrap.mockReturnValue("/usr/bin/bwrap");
      mockFindHelper.mockReturnValue(undefined);

      const sandbox = new Sandbox(DEFAULT_POLICY, [
        "--unshare-pid", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--ro-bind", "/bin", "/bin", "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
      ]);
      const result = await sandbox.execute("/bin/true", []);

      expect(result.enforcement!.pivotRoot).toBe(true);
      expect(result.enforcement!.bindMounts).toBe(true);
      expect(result.enforcement!.namespaces).toBe(true);
    },
  );
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/sandbox/src/sandbox.test.ts --reporter=verbose`
Expected: FAIL — constructor signature mismatch.

**Step 3: Rewrite the Sandbox class**

Replace the entire contents of `packages/sandbox/src/sandbox.ts`:

```typescript
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { SandboxPolicy, SandboxResult, EnforcementLayers } from "./types.js";
import { assertSandboxSupported } from "./detect.js";
import { findHelper, findBwrap } from "./helper.js";

export class Sandbox {
  private readonly policy: SandboxPolicy;
  private readonly bwrapPath: string;
  private readonly bwrapArgs: string[];
  private readonly helperPath: string | undefined;

  constructor(policy: SandboxPolicy, bwrapArgs: string[]) {
    assertSandboxSupported();
    this.policy = policy;
    this.bwrapPath = findBwrap();
    this.bwrapArgs = bwrapArgs;
    this.helperPath = findHelper();
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const start = performance.now();
    const timeout = this.policy.timeoutMs ?? 30_000;

    const useBwrap = true; // bwrap is mandatory
    const useHelper = this.helperPath !== undefined;

    const enforcement: EnforcementLayers = {
      namespaces: useBwrap,
      pivotRoot: useBwrap,
      bindMounts: useBwrap,
      landlock: useHelper,
      seccomp: useHelper,
      capDrop: useHelper,
    };

    let spawnCmd: string;
    let spawnArgs: string[];
    let stdio: ("ignore" | "pipe")[];

    if (useHelper) {
      // bwrap [flags] -- helper -- command [args]
      spawnCmd = this.bwrapPath;
      spawnArgs = [...this.bwrapArgs, "--", this.helperPath!, "--", command, ...args];
      stdio = ["ignore", "pipe", "pipe", "pipe"];
    } else {
      // bwrap [flags] -- command [args]
      spawnCmd = this.bwrapPath;
      spawnArgs = [...this.bwrapArgs, "--", command, ...args];
      stdio = ["ignore", "pipe", "pipe"];
    }

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn(spawnCmd, spawnArgs, {
        stdio,
        detached: true,
      });

      // Write policy JSON to fd 3 when using helper
      if (useHelper) {
        const fd3 = proc.stdio[3] as Writable;
        fd3.on("error", () => {
          // Ignored: the child may exit before reading fd 3
        });
        const policyJson = JSON.stringify({
          filesystem: this.policy.filesystem,
          syscalls: this.policy.syscalls,
        });
        fd3.end(policyJson);
      }

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

**Step 4: Update bootstrap.ts to pass bwrapArgs**

In `packages/cli/src/commands/bootstrap.ts`, update the sandbox construction section (around line 173-194). The `PolicyBuilder` import already exists. Add `findBwrap` to the import from `@safeclaw/sandbox` (line 35):

```typescript
import { Sandbox, PolicyBuilder, findBwrap } from "@safeclaw/sandbox";
```

Replace lines 173-194:

```typescript
  // Build sandbox policy — we extract allowed paths for bash tool validation
  const builder = PolicyBuilder.forDevelopment(process.cwd());
  const sandboxPolicy = builder.build();
  const allowedCommandPaths = sandboxPolicy.filesystem.allow
    .filter((r) => r.access === "execute" || r.access === "readwrite")
    .map((r) => r.path);

  const braveApiKey = vault.get("brave_api_key");
  const processManager = new ProcessManager();
  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools({ braveApiKey, processManager, allowedCommandPaths })) {
    toolRegistry.register(tool);
  }

  let sandbox: Sandbox | undefined;
  try {
    const helperPath = findHelper();
    const bwrapArgs = builder.toBwrapArgs(helperPath);
    sandbox = new Sandbox(sandboxPolicy, bwrapArgs);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    output.write(
      `Warning: sandbox not available (${detail}), tools will run unsandboxed\n`,
    );
  }
```

Add `findHelper` to the import from `@safeclaw/sandbox`:

```typescript
import { Sandbox, PolicyBuilder, findBwrap, findHelper } from "@safeclaw/sandbox";
```

Wait — `findHelper` is already exported but the bootstrap file doesn't import it (it calls `findHelper()` indirectly via `Sandbox` constructor). Now the constructor calls `findHelper()` internally, so bootstrap just needs to pass the helper path for `toBwrapArgs()`. Let's keep it simple — import `findHelper`:

```typescript
import { Sandbox, PolicyBuilder, findHelper } from "@safeclaw/sandbox";
```

(We don't need to import `findBwrap` since the Sandbox constructor calls it internally.)

**Step 5: Update sandbox-escape.test.ts**

Update the `Sandbox` constructor calls to pass bwrapArgs. Since these tests mock out the helper and detect modules, the Sandbox constructor won't actually call the real `findBwrap`. We need to mock it:

Add to the mock at line 44:

```typescript
vi.mock("../../packages/sandbox/src/helper.js", () => ({
  findHelper: () => undefined,
  findBwrap: () => "/usr/bin/bwrap",
}));
```

Update all `new Sandbox(DEFAULT_POLICY)` calls to `new Sandbox(DEFAULT_POLICY, ["--unshare-pid"])`.

**Step 6: Update integration.test.ts**

Update the `Sandbox` constructor call and add bwrap args. The integration test needs to build proper bwrap args from the policy.

**Step 7: Run all sandbox tests**

Run: `pnpm vitest run packages/sandbox/src/ test/security/sandbox-escape.test.ts --reporter=verbose`
Expected: PASS

**Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 9: Commit**

```
git add -A && git commit -m "feat(sandbox): replace unshare with bwrap in Sandbox.execute()"
```

---

### Task 6: Replace unshareCheck with bwrapCheck in doctor

**Files:**
- Modify: `packages/cli/src/commands/doctor-checks.ts:155-183` (replace unshareCheck with bwrapCheck)
- Modify: `packages/cli/src/commands/doctor.ts:8,165` (update import and usage)
- Modify: `packages/cli/src/commands/doctor-checks.test.ts:102-116` (update tests)

**Step 1: Write failing tests**

In `packages/cli/src/commands/doctor-checks.test.ts`, replace the `describe("unshareCheck"` block (lines 102-117):

```typescript
describe("bwrapCheck", () => {
  it("passes when bwrap is available", async () => {
    const check = bwrapCheck({ execFileSync: (cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "bwrap") return "/usr/bin/bwrap\n";
      if (cmd === "bwrap" && args[0] === "--version") return "bubblewrap 0.9.0\n";
      throw new Error("unexpected");
    }});
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("bwrap");
    expect(result.message).toContain("0.9.0");
  });

  it("fails when bwrap is not found", async () => {
    const check = bwrapCheck({
      execFileSync: () => { throw new Error("not found"); },
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("bubblewrap");
  });
});
```

Update the import at the top of the test file to use `bwrapCheck` instead of `unshareCheck`.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts --reporter=verbose`
Expected: FAIL — `bwrapCheck` not exported.

**Step 3: Replace `unshareCheck` with `bwrapCheck` in doctor-checks.ts**

Replace lines 155-183:

```typescript
export interface BwrapDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function bwrapCheck(
  deps: BwrapDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "bwrap",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        deps.execFileSync("which", ["bwrap"]);
      } catch {
        return {
          status: "fail",
          message: "bubblewrap (bwrap) not found",
          detail:
            "bubblewrap is required for filesystem isolation via pivot_root. " +
            "Install: apt install bubblewrap (Debian/Ubuntu) or dnf install bubblewrap (Fedora).",
        };
      }
      try {
        const versionOutput = deps.execFileSync("bwrap", ["--version"]);
        const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
        const version = match?.[1] ?? "unknown";
        return {
          status: "pass",
          message: `bubblewrap ${version} available`,
        };
      } catch {
        return {
          status: "pass",
          message: "bubblewrap available (version unknown)",
        };
      }
    },
  };
}
```

Remove the old `UnshareDeps` interface and `unshareCheck` function.

**Step 4: Update doctor.ts**

In `packages/cli/src/commands/doctor.ts`, change the import (line 8) from `unshareCheck` to `bwrapCheck`, and update line 165:

```typescript
    bwrapCheck(),
```

**Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts --reporter=verbose`
Expected: PASS

**Step 6: Commit**

```
git add -A && git commit -m "feat(cli): replace unshareCheck with bwrapCheck in doctor"
```

---

### Task 7: Update integration tests for bwrap

**Files:**
- Modify: `packages/sandbox/src/integration.test.ts`

**Step 1: Update existing integration tests**

The integration test file currently uses `unshare` directly and constructs `Sandbox` with a single argument. Update it to:

1. Change the bwrap availability probe (replace `canUnshareUser` with `canBwrap`)
2. Update `Sandbox` constructor calls to pass `bwrapArgs`
3. Add bwrap-specific integration tests

Replace the user namespace probe at lines 26-34:

```typescript
let canBwrap = false;
try {
  execFileSync("bwrap", [
    "--unshare-pid", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--ro-bind", "/bin", "/bin", "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--", "/bin/true",
  ], { timeout: 3000 });
  canBwrap = true;
} catch {
  // bwrap not available — skip dependent tests
}
```

Update the mock for `helper.js` to also export `findBwrap`:

```typescript
vi.mock("./helper.js", () => ({
  findHelper: () => helperPath,
  findBwrap: () => "/usr/bin/bwrap",
}));
```

Update `Sandbox` construction in tests to pass `PolicyBuilder`-generated bwrap args. Build them from the `ECHO_POLICY`:

```typescript
// Build bwrap args from the policy's path rules
const echoBwrapArgs = [
  "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
  "--die-with-parent", "--new-session",
  "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
  "--ro-bind", "/bin", "/bin",
  "--ro-bind", "/usr", "/usr",
  "--ro-bind", "/lib", "/lib",
  "--ro-bind", "/lib64", "/lib64",
  "--ro-bind", "/etc", "/etc",
];
if (helperPath) {
  echoBwrapArgs.push("--ro-bind", helperPath, helperPath);
}
```

**Step 2: Add bwrap-specific integration tests**

Add new tests to verify bwrap isolation:

```typescript
  it.skipIf(!canBwrap || !helperPath)(
    "host paths not in allow list are invisible inside sandbox",
    async () => {
      const sandbox = new Sandbox(ECHO_POLICY, echoBwrapArgs);
      const result = await sandbox.execute("/bin/sh", [
        "-c", "ls /home 2>&1 || echo NOTFOUND",
      ]);
      // /home is not in our bind mounts, so it should not exist
      expect(result.stdout + result.stderr).toContain("NOTFOUND");
    },
  );

  it.skipIf(!canBwrap || !helperPath)(
    "/tmp is empty (fresh tmpfs)",
    async () => {
      const sandbox = new Sandbox(ECHO_POLICY, echoBwrapArgs);
      const result = await sandbox.execute("/bin/sh", [
        "-c", "ls -A /tmp | wc -l",
      ]);
      expect(result.stdout.trim()).toBe("0");
    },
  );
```

**Step 3: Run integration tests**

Run: `pnpm vitest run packages/sandbox/src/integration.test.ts --reporter=verbose`
Expected: PASS (on machines with bwrap installed)

**Step 4: Commit**

```
git add -A && git commit -m "test(sandbox): update integration tests for bwrap spawn chain"
```

---

### Task 8: Add bwrap security tests

**Files:**
- Modify: `test/security/sandbox-escape.test.ts`

**Step 1: Add security tests for pivot_root isolation**

Add a new `describe` block at the end of `test/security/sandbox-escape.test.ts`:

```typescript
describe("bwrap pivot_root isolation", () => {
  let canBwrap = false;
  try {
    execFileSync("bwrap", [
      "--unshare-pid", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--ro-bind", "/bin", "/bin", "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--", "/bin/true",
    ], { timeout: 3000 });
    canBwrap = true;
  } catch {
    // bwrap not available
  }

  it.skipIf(!canBwrap)(
    "~/.ssh is not accessible inside the sandbox",
    async () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const bwrapArgs = [
        "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
        "--die-with-parent", "--new-session",
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc",
      ];

      const sandbox = new Sandbox(DEFAULT_POLICY, bwrapArgs);
      const result = await sandbox.execute("/bin/sh", [
        "-c", "test -d ~/.ssh && echo EXISTS || echo ABSENT",
      ]);
      expect(result.stdout.trim()).toBe("ABSENT");
    },
  );

  it.skipIf(!canBwrap)(
    "~/.aws is not accessible inside the sandbox",
    async () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const bwrapArgs = [
        "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
        "--die-with-parent", "--new-session",
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
      ];

      const sandbox = new Sandbox(DEFAULT_POLICY, bwrapArgs);
      const result = await sandbox.execute("/bin/sh", [
        "-c", "test -d ~/.aws && echo EXISTS || echo ABSENT",
      ]);
      expect(result.stdout.trim()).toBe("ABSENT");
    },
  );

  it.skipIf(!canBwrap)(
    "~/.gnupg is not accessible inside the sandbox",
    async () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const bwrapArgs = [
        "--unshare-pid", "--unshare-net",
        "--die-with-parent", "--new-session",
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
      ];

      const sandbox = new Sandbox(DEFAULT_POLICY, bwrapArgs);
      const result = await sandbox.execute("/bin/sh", [
        "-c", "test -d ~/.gnupg && echo EXISTS || echo ABSENT",
      ]);
      expect(result.stdout.trim()).toBe("ABSENT");
    },
  );
});
```

**Step 2: Run security tests**

Run: `pnpm vitest run test/security/sandbox-escape.test.ts --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```
git add -A && git commit -m "test(security): add bwrap pivot_root and home dir isolation tests"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/sandboxing.md`
- Modify: `docs/security-model.md`
- Modify: `docs/getting-started.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Step 1: Update docs/sandboxing.md**

Key changes:
- Update the architecture diagram to show `bwrap -> helper -> command` instead of `unshare -> helper -> command`
- Add "pivot_root" and "bind mounts" as enforcement layers (total: 7 layers now)
- Update the spawn chain documentation
- Update the threat model section to reflect that host filesystem paths are now invisible
- Remove references to `unshare(1)` and replace with `bwrap`
- Add a section on selective home directory binding

**Step 2: Update docs/security-model.md**

Key changes:
- Update the "Sandboxing" section to describe the two-layer architecture (bwrap outer + C helper inner)
- Add `pivot_root` to the namespace table
- Update the STRIDE threat model to include the new isolation properties
- Update `EnforcementLayers` documentation to include `pivotRoot` and `bindMounts`

**Step 3: Update docs/getting-started.md**

Key changes:
- Add `bubblewrap` to the prerequisites list
- Add installation command: `apt install bubblewrap` / `dnf install bubblewrap`
- Update the doctor output example to show `bwrap` check instead of `unshare`
- Update kernel verification section if needed

**Step 4: Update README.md**

Key changes:
- Update the Security features list to mention `pivot_root` filesystem isolation via bubblewrap
- Add `bubblewrap` to system requirements in the quick install section
- Add a roadmap entry for bubblewrap sandbox integration linking to `docs/plans/2026-03-07-bubblewrap-sandbox-design.md`, marked as the current in-progress item
- Update any feature bullet points that mention `unshare` or namespace isolation to reflect the new bwrap-based architecture

**Step 5: Update AGENTS.md**

Key changes:
- Update the Sandbox section description to mention bwrap/pivot_root
- Update the spawn chain description
- Update `DevelopmentPolicyOptions` description to include new fields

**Step 6: Commit**

```
git add -A && git commit -m "docs: update documentation for bubblewrap sandbox integration"
```

---

### Task 10: Run full test suite and lint

**Files:** None (verification only)

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors)

**Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS (no lint errors)

**Step 3: Run all tests**

Run: `pnpm test`
Expected: PASS

**Step 4: If any failures, fix and commit**

Fix any remaining issues and commit with appropriate message.

**Step 5: Clean up draft design doc**

Delete the earlier draft: `rm .opencode/plans/2026-03-07-bubblewrap-sandbox-design.md` (if it exists).

**Step 6: Final commit if cleanup needed**

```
git add -A && git commit -m "chore: clean up draft design doc"
```
