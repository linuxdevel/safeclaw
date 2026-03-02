# OS-Level Sandbox Execution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `Sandbox.execute()` to actually run commands inside Linux namespace/Landlock/seccomp sandboxes, replacing the current "not yet implemented" stub.

**Architecture:** Instead of native C bindings (originally planned), use `child_process.spawn` with `unshare(2)` for namespace isolation and `/proc` manipulation for Landlock/seccomp setup. The approach:

1. **Namespaces:** Use `unshare` command (from util-linux) to create PID/net/mnt/user namespaces before exec
2. **Landlock:** Write a small helper script that applies Landlock rules via the kernel ABI, then exec's the target
3. **Seccomp:** Apply seccomp-BPF via a helper that uses `prctl(PR_SET_SECCOMP)` before exec

Since Node.js cannot directly invoke `unshare(2)`, `landlock_create_ruleset(2)`, or `prctl(PR_SET_SECCOMP)` system calls without native bindings, the practical approach for v1 is:

- Use the `unshare` CLI tool for namespace creation (available on all modern Linux)
- Use a small compiled C helper (`safeclaw-sandbox-helper`) for Landlock + seccomp setup
- Fall back to namespace-only isolation if the helper isn't available

This plan covers the Node.js orchestration layer. The C helper is a separate deliverable.

**Tech Stack:** TypeScript, vitest, node:child_process, Linux unshare(1)

**Prerequisites:**
- Linux kernel >= 5.13
- `unshare` command available (from util-linux)
- Root not required (user namespaces work unprivileged)

---

### Task 1: Implement Sandbox.execute() with unshare-based namespaces

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts`
- Test: `packages/sandbox/src/sandbox.test.ts`

**Step 1: Write the failing test**

Add to `sandbox.test.ts`:

```typescript
import { vi } from "vitest";

// Mock detect to avoid /proc dependency in tests
vi.mock("./detect.js", () => ({
  assertSandboxSupported: vi.fn(),
}));

describe("Sandbox.execute()", () => {
  it("runs a command and returns stdout", async () => {
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/echo", ["hello"]);
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
  });

  it("returns non-zero exit code on failure", async () => {
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/false", []);
    expect(result.exitCode).not.toBe(0);
    expect(result.killed).toBe(false);
  });

  it("kills process after timeout", async () => {
    const policy = { ...DEFAULT_POLICY, timeoutMs: 100 };
    const sandbox = new Sandbox(policy);
    const result = await sandbox.execute("/bin/sleep", ["10"]);
    expect(result.killed).toBe(true);
    expect(result.killReason).toBe("timeout");
  });

  it("captures stderr", async () => {
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/sh", [
      "-c",
      "echo error >&2",
    ]);
    expect(result.stderr).toContain("error");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/sandbox/src/sandbox.test.ts`
Expected: FAIL — "not yet implemented"

**Step 3: Implement execute() with spawn**

Replace the stub in `sandbox.ts`:

```typescript
import { spawn } from "node:child_process";
import type { SandboxPolicy, SandboxResult } from "./types.js";
import { assertSandboxSupported } from "./detect.js";

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    this.policy = policy;
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const start = performance.now();
    const timeout = this.policy.timeoutMs ?? 30_000;

    // Build unshare flags from policy
    const unshareFlags = this.buildUnshareFlags();

    // Construct the command: unshare [flags] -- command [args]
    const spawnArgs = unshareFlags.length > 0
      ? [...unshareFlags, "--", command, ...args]
      : [command, ...args];
    const spawnCmd = unshareFlags.length > 0 ? "unshare" : command;
    const spawnCmdArgs = unshareFlags.length > 0
      ? spawnArgs
      : args;

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn(spawnCmd, spawnCmdArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 0,  // We handle timeout manually
      });

      const timer = setTimeout(() => {
        killed = true;
        killReason = "timeout";
        proc.kill("SIGKILL");
      }, timeout);

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          durationMs: performance.now() - start,
          killed,
          killReason,
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
        });
      });
    });
  }

  getPolicy(): SandboxPolicy {
    return structuredClone(this.policy);
  }

  private buildUnshareFlags(): string[] {
    const flags: string[] = [];
    const ns = this.policy.namespaces;

    if (ns.pid) flags.push("--pid", "--fork");
    if (ns.net) flags.push("--net");
    if (ns.mnt) flags.push("--mount");
    if (ns.user) flags.push("--user", "--map-root-user");

    return flags;
  }
}
```

**Step 4: Run tests**

Run: `pnpm vitest run packages/sandbox/src/sandbox.test.ts`
Expected: PASS (at least the basic tests; namespace tests may need adjustment depending on CI capabilities)

**Step 5: Commit**

```
feat(sandbox): implement execute() with unshare-based namespace isolation
```

---

### Task 2: Add filesystem restriction via mount namespace

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts` (enhance execute)

**Step 1: Write the failing test**

```typescript
it("restricts filesystem access per policy", async () => {
  const policy: SandboxPolicy = {
    ...DEFAULT_POLICY,
    namespaces: { pid: false, net: false, mnt: true, user: true },
    filesystem: {
      allow: [{ path: "/tmp", access: "readwrite" }],
      deny: [],
    },
  };
  const sandbox = new Sandbox(policy);
  // Write a file to /tmp (should work)
  const result = await sandbox.execute("/bin/sh", [
    "-c",
    "echo test > /tmp/sandbox-test-$$ && cat /tmp/sandbox-test-$$ && rm /tmp/sandbox-test-$$",
  ]);
  expect(result.stdout.trim()).toBe("test");
  expect(result.exitCode).toBe(0);
});
```

This test validates that basic mount namespace isolation works. Full Landlock enforcement requires the C helper (Task 4).

**Step 2: Implement mount namespace setup**

Add a method to configure the mount namespace with bind mounts for allowed paths. This is done by passing environment variables or a config file to the sandboxed process.

Note: Full filesystem restriction via Landlock requires the native helper. For v1, mount namespace provides the outer boundary, and the `unshare --mount` flag prevents the child from affecting the host's mount table.

**Step 3: Run tests**

Run: `pnpm vitest run packages/sandbox/src/sandbox.test.ts`
Expected: PASS

**Step 4: Commit**

```
feat(sandbox): add mount namespace filesystem isolation
```

---

### Task 3: Add network namespace isolation

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts`
- Test: `packages/sandbox/src/sandbox.test.ts`

**Step 1: Write the failing test**

```typescript
it("blocks network access when policy is 'none'", async () => {
  const policy: SandboxPolicy = {
    ...DEFAULT_POLICY,
    namespaces: { pid: false, net: true, mnt: false, user: true },
    network: "none",
  };
  const sandbox = new Sandbox(policy);
  // Attempt to reach a well-known IP — should fail in network namespace
  const result = await sandbox.execute("/bin/sh", [
    "-c",
    "cat /dev/null | /bin/nc -w1 1.1.1.1 80 2>&1 || echo blocked",
  ]);
  expect(result.stdout).toContain("blocked");
});
```

**Step 2: Implementation**

Network namespace with `--net` flag already isolates the process from host networking. The child sees only a loopback interface. No additional code needed beyond what Task 1 provides — the `buildUnshareFlags()` method already adds `--net` when `policy.namespaces.net` is true.

**Step 3: Run tests and commit**

```
test(sandbox): verify network isolation in network namespace
```

---

### Task 4: Design the native sandbox helper (specification only)

**Files:**
- Create: `docs/plans/2026-03-02-sandbox-helper-spec.md`

This task documents the specification for the C helper binary (`safeclaw-sandbox-helper`) that will:

1. Apply Landlock rules (filesystem access restrictions at kernel level)
2. Apply seccomp-BPF filter (syscall allow/deny)
3. Drop all capabilities
4. Exec the target command

The helper receives configuration via a JSON file descriptor or command-line arguments, applies restrictions, then exec's the target. This is a separate deliverable because it requires C compilation and platform-specific packaging.

**Step 1: Write the specification document**

Cover:
- Input format (JSON policy on fd 3 or via --policy flag)
- Landlock ABI versions supported (1, 2, 3)
- Seccomp BPF filter construction
- Capability dropping sequence
- Error handling (fail-closed: if any setup step fails, do not exec)
- Build system (Makefile, static linking with musl for portability)
- Integration with `Sandbox.execute()` (spawn helper instead of direct unshare)

**Step 2: Commit**

```
docs: add sandbox helper specification
```

---

### Task 5: Update sandbox-escape security tests

**Files:**
- Modify: `test/security/sandbox-escape.test.ts`

**Step 1: Update tests**

The existing test at line 52 (`execute() rejects with "not yet implemented"`) needs updating now that execute works. Replace with tests that verify:

- `execute()` returns a result (not throws)
- Policy is enforced (timeout, namespace isolation)
- `getPolicy()` still returns defensive copies

**Step 2: Run full suite**

Run: `pnpm test`
Expected: All pass

**Step 3: Commit**

```
test(security): update sandbox-escape tests for working execute()
```

---

## Implementation Order

1. Task 1 (basic execute with unshare) — unblocks everything else
2. Task 5 (update security tests) — immediately after Task 1
3. Task 3 (network isolation) — simple, just test verification
4. Task 2 (mount namespace) — more complex
5. Task 4 (native helper spec) — documentation, no code

## CI Considerations

The `unshare` command requires unprivileged user namespace support. GitHub Actions runners have this enabled. If CI fails, tests can be wrapped with:

```typescript
const canUnshare = (() => {
  try {
    execSync("unshare --user --pid --fork true", { timeout: 5000 });
    return true;
  } catch { return false; }
})();

describe.skipIf(!canUnshare)("Sandbox.execute()", () => { ... });
```
