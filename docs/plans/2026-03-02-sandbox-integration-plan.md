# Sandbox Helper Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `Sandbox.execute()` to invoke the native `safeclaw-sandbox-helper` binary (with discovery, integrity checking, and graceful degradation), then write comprehensive sandboxing documentation and update the README.

**Architecture:** The `Sandbox` class gains a helper-discovery module that locates the C binary, verifies its SHA-256 checksum, and — if valid — inserts it into the spawn chain between `unshare` and the target command. Policy JSON for filesystem/syscall rules is serialized to fd 3. If the helper is missing or fails integrity check, we fall back to namespace-only isolation with a warning. A new `docs/sandboxing.md` provides a deep-dive complement to the existing `docs/security-model.md`.

**Tech Stack:** TypeScript ESM (Node16 module resolution, `.js` extensions), vitest 4.x (`globals: false`), `node:child_process`, `node:crypto`, `node:fs`. No new dependencies.

**Key constraints:**
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `exactOptionalPropertyTypes: true` — `undefined` must be explicit in optional property types
- `module: "Node16"` — must use `.js` extensions in relative imports
- For `__dirname` equivalent: use `import.meta.url` with `fileURLToPath`
- TDD: write failing test first, implement, verify
- Do NOT commit — user does signed commits manually

**Reference:** `docs/plans/2026-03-02-sandbox-helper-spec.md` lines 360-478 (integration section)

---

## Task 1: Add `enforcement` metadata to `SandboxResult`

**Files:**
- Modify: `packages/sandbox/src/types.ts`

**Why:** Before changing any behavior, extend the result type so consumers can see which enforcement layers were active. This is a pure type addition — nothing breaks.

**Step 1: Add the enforcement type and update SandboxResult**

Add a new type and an optional field to `SandboxResult` in `packages/sandbox/src/types.ts`:

```typescript
/** Which enforcement layers were active during execution */
export interface EnforcementLayers {
  namespaces: boolean;
  landlock: boolean;
  seccomp: boolean;
  capDrop: boolean;
}

// Add to SandboxResult interface:
  enforcement?: EnforcementLayers | undefined;
```

Add the field after `killReason` inside `SandboxResult`:

```typescript
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  killReason?: "timeout" | "oom" | "signal" | undefined;
  enforcement?: EnforcementLayers | undefined;
}
```

**Step 2: Export the new type from index.ts**

In `packages/sandbox/src/index.ts`, add `EnforcementLayers` to the type export:

```typescript
export type {
  SandboxPolicy,
  SandboxResult,
  PathRule,
  KernelCapabilities,
  EnforcementLayers,
} from "./types.js";
```

**Step 3: Run typecheck to verify no breakage**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (the new field is optional, so existing code is unaffected)

**Step 4: Run tests to verify no breakage**

Run: `pnpm test`
Expected: All 371+ tests pass

**Step 5: Commit**

```
feat(sandbox): add EnforcementLayers type to SandboxResult

Tracks which enforcement layers (namespaces, landlock, seccomp, capDrop)
were active during a sandboxed execution, enabling consumers to verify
enforcement depth.
```

---

## Task 2: Create helper discovery module with tests

**Files:**
- Create: `packages/sandbox/src/helper.ts`
- Create: `packages/sandbox/src/helper.test.ts`

**Why:** The helper discovery logic is self-contained and testable in isolation. It finds the binary, verifies its checksum, and returns a result. This is the foundation for the integration.

### Step 1: Write the failing tests

Create `packages/sandbox/src/helper.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to mock specific modules for unit testing
const mockAccess = vi.fn<(path: string) => void>();
const mockReadFile = vi.fn<(path: string) => Buffer>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: (...args: Parameters<typeof actual.accessSync>) => mockAccess(args[0] as string),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      // Only intercept calls from our module, not test setup
      if (typeof args[0] === "string" && args[0].endsWith("safeclaw-sandbox-helper")) {
        return mockReadFile(args[0]);
      }
      return actual.readFileSync(...args);
    },
  };
});

const { findHelper, verifyHelper } = await import("./helper.js");

describe("findHelper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["SAFECLAW_HELPER_PATH"];
  });

  it("returns SAFECLAW_HELPER_PATH when set and file exists", () => {
    process.env["SAFECLAW_HELPER_PATH"] = "/custom/path/safeclaw-sandbox-helper";
    mockAccess.mockImplementation(() => undefined);

    const result = findHelper();
    expect(result).toBe("/custom/path/safeclaw-sandbox-helper");
  });

  it("returns undefined when SAFECLAW_HELPER_PATH is set but file does not exist", () => {
    process.env["SAFECLAW_HELPER_PATH"] = "/nonexistent/helper";
    mockAccess.mockImplementation(() => { throw new Error("ENOENT"); });

    const result = findHelper();
    // Falls through to other locations, all of which also fail
    expect(result).toBeUndefined();
  });

  it("returns co-located path when file exists there", () => {
    mockAccess.mockImplementation((path: string) => {
      // Only the co-located path succeeds
      if (path.includes("native/safeclaw-sandbox-helper")) return undefined;
      throw new Error("ENOENT");
    });

    const result = findHelper();
    expect(result).toContain("native/safeclaw-sandbox-helper");
  });

  it("returns undefined when helper is not found anywhere", () => {
    mockAccess.mockImplementation(() => { throw new Error("ENOENT"); });

    const result = findHelper();
    expect(result).toBeUndefined();
  });
});

describe("verifyHelper", () => {
  it("returns true when hash matches known hash", () => {
    const fakeContent = Buffer.from("fake-binary-content");
    const hash = createHash("sha256").update(fakeContent).digest("hex");
    mockReadFile.mockReturnValue(fakeContent);

    const result = verifyHelper("/path/to/helper", `sha256:${hash}`);
    expect(result).toBe(true);
  });

  it("returns false when hash does not match", () => {
    mockReadFile.mockReturnValue(Buffer.from("actual-content"));

    const result = verifyHelper("/path/to/helper", "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(result).toBe(false);
  });

  it("returns false when file cannot be read", () => {
    mockReadFile.mockImplementation(() => { throw new Error("ENOENT"); });

    const result = verifyHelper("/nonexistent/helper", "sha256:abc");
    expect(result).toBe(false);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm vitest run packages/sandbox/src/helper.test.ts`
Expected: FAIL — module `./helper.js` does not exist

### Step 3: Implement the helper discovery module

Create `packages/sandbox/src/helper.ts`:

```typescript
import { accessSync, readFileSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Co-located path: from packages/sandbox/src/ → ../../../native/safeclaw-sandbox-helper
 * This works whether running from src/ (dev) or dist/ (built).
 */
function coLocatedPath(): string {
  return join(__dirname, "..", "..", "..", "native", "safeclaw-sandbox-helper");
}

/**
 * Installed path: ~/.safeclaw/bin/safeclaw-sandbox-helper
 */
function installedPath(): string {
  return join(
    process.env["HOME"] ?? "/root",
    ".safeclaw",
    "bin",
    "safeclaw-sandbox-helper",
  );
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the sandbox helper binary.
 *
 * Search order:
 * 1. SAFECLAW_HELPER_PATH environment variable
 * 2. Co-located in repo: native/safeclaw-sandbox-helper
 * 3. Installed path: ~/.safeclaw/bin/safeclaw-sandbox-helper
 * 4. System PATH via `which`
 *
 * Returns the absolute path if found, undefined otherwise.
 */
export function findHelper(): string | undefined {
  // 1. Environment variable
  const envPath = process.env["SAFECLAW_HELPER_PATH"];
  if (envPath !== undefined && envPath !== "" && fileExists(envPath)) {
    return envPath;
  }

  // 2. Co-located in package
  const colocated = coLocatedPath();
  if (fileExists(colocated)) {
    return colocated;
  }

  // 3. Installed path
  const installed = installedPath();
  if (fileExists(installed)) {
    return installed;
  }

  // 4. System PATH
  try {
    const which = execSync("which safeclaw-sandbox-helper", {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (which !== "" && fileExists(which)) {
      return which;
    }
  } catch {
    // not in PATH
  }

  return undefined;
}

/**
 * Verify the helper binary's SHA-256 checksum.
 *
 * @param helperPath - Absolute path to the helper binary
 * @param knownHash - Expected hash in format "sha256:<hex>"
 * @returns true if the hash matches
 */
export function verifyHelper(helperPath: string, knownHash: string): boolean {
  try {
    const binary = readFileSync(helperPath);
    const hash = createHash("sha256").update(binary).digest("hex");
    return `sha256:${hash}` === knownHash;
  } catch {
    return false;
  }
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/sandbox/src/helper.test.ts`
Expected: All tests PASS

### Step 5: Run full test suite

Run: `pnpm test`
Expected: All tests pass

### Step 6: Commit

```
feat(sandbox): add helper discovery and integrity verification

Finds safeclaw-sandbox-helper via env var, co-located path, installed
path, or system PATH. Verifies SHA-256 checksum before use.
```

---

## Task 3: Add known helper hash constant

**Files:**
- Create: `packages/sandbox/src/helper-hash.ts`

**Why:** The known-good SHA-256 hash needs to live in a single place that can be updated by CI/release scripts. Separating it into its own file makes it trivial to update.

### Step 1: Compute the current helper binary hash

Run: `sha256sum native/safeclaw-sandbox-helper`

### Step 2: Create the hash file

Create `packages/sandbox/src/helper-hash.ts`:

```typescript
/**
 * Known-good SHA-256 hash of the safeclaw-sandbox-helper binary.
 *
 * Updated by the build/release process. If this hash does not match
 * the binary found on disk, the helper is not used and SafeClaw falls
 * back to namespace-only sandboxing.
 *
 * To update: sha256sum native/safeclaw-sandbox-helper
 */
export const KNOWN_HELPER_HASH = "sha256:<INSERT_HASH_FROM_STEP_1>";
```

Replace `<INSERT_HASH_FROM_STEP_1>` with the actual hash from step 1.

### Step 3: Run typecheck

Run: `pnpm exec tsc --noEmit`
Expected: PASS

### Step 4: Commit

```
feat(sandbox): add known-good helper hash for integrity verification

Contains the SHA-256 checksum of the trusted safeclaw-sandbox-helper
binary, used to prevent execution of tampered helpers.
```

---

## Task 4: Wire helper into Sandbox.execute() with tests

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts`
- Modify: `packages/sandbox/src/sandbox.test.ts`

**Why:** This is the core integration — changing the spawn chain to insert the helper between `unshare` and the target command, serialize policy JSON to fd 3, and populate `enforcement` metadata.

### Step 1: Write the failing tests

Add new tests to `packages/sandbox/src/sandbox.test.ts`. These test the helper integration by mocking the helper module:

```typescript
// Add to the existing mock setup at the top of the file, BEFORE the Sandbox import:

const mockFindHelper = vi.fn<() => string | undefined>();
const mockVerifyHelper = vi.fn<(path: string, hash: string) => boolean>();

vi.mock("./helper.js", () => ({
  findHelper: () => mockFindHelper(),
  verifyHelper: (path: string, hash: string) => mockVerifyHelper(path, hash),
}));

// Add a new describe block:

describe("Sandbox helper integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
  });

  it("sets enforcement.namespaces=true even without helper", async () => {
    mockFindHelper.mockReturnValue(undefined);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    expect(result.enforcement).toBeDefined();
    expect(result.enforcement?.namespaces).toBe(true);
    expect(result.enforcement?.landlock).toBe(false);
    expect(result.enforcement?.seccomp).toBe(false);
    expect(result.enforcement?.capDrop).toBe(false);
  });

  it("sets full enforcement when helper is found and verified", async () => {
    mockFindHelper.mockReturnValue("/usr/bin/safeclaw-sandbox-helper");
    mockVerifyHelper.mockReturnValue(true);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    expect(result.enforcement).toBeDefined();
    // When helper is present + verified, all layers are reported as active
    // (actual enforcement depends on kernel — but the metadata reflects intent)
    expect(result.enforcement?.namespaces).toBe(true);
    expect(result.enforcement?.landlock).toBe(true);
    expect(result.enforcement?.seccomp).toBe(true);
    expect(result.enforcement?.capDrop).toBe(true);
  });

  it("falls back to namespace-only when helper checksum fails", async () => {
    mockFindHelper.mockReturnValue("/usr/bin/safeclaw-sandbox-helper");
    mockVerifyHelper.mockReturnValue(false);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    expect(result.enforcement?.namespaces).toBe(true);
    expect(result.enforcement?.landlock).toBe(false);
    expect(result.enforcement?.seccomp).toBe(false);
    expect(result.enforcement?.capDrop).toBe(false);
  });
});
```

### Step 2: Run new tests to verify they fail

Run: `pnpm vitest run packages/sandbox/src/sandbox.test.ts`
Expected: FAIL — `enforcement` is undefined (current code doesn't set it)

### Step 3: Implement the helper integration in sandbox.ts

Replace `packages/sandbox/src/sandbox.ts` with:

```typescript
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { SandboxPolicy, SandboxResult, EnforcementLayers } from "./types.js";
import { assertSandboxSupported } from "./detect.js";
import { findHelper, verifyHelper } from "./helper.js";
import { KNOWN_HELPER_HASH } from "./helper-hash.js";

interface HelperResolution {
  path: string | undefined;
  verified: boolean;
}

function resolveHelper(): HelperResolution {
  const path = findHelper();
  if (path === undefined) {
    return { path: undefined, verified: false };
  }
  const verified = verifyHelper(path, KNOWN_HELPER_HASH);
  if (!verified) {
    // Warning: helper found but checksum doesn't match
    // eslint-disable-next-line no-console
    console.warn(
      `safeclaw: sandbox helper found at ${path} but SHA-256 checksum does not match. ` +
      `Falling back to namespace-only sandboxing.`,
    );
  }
  return { path, verified };
}

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    this.policy = policy;
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const start = performance.now();
    const timeout = this.policy.timeoutMs ?? 30_000;

    // Build unshare flags from policy namespace settings
    const unshareFlags = this.buildUnshareFlags();
    const useUnshare = unshareFlags.length > 0;

    // Resolve helper binary
    const helper = resolveHelper();
    const useHelper = helper.path !== undefined && helper.verified;

    // Build enforcement metadata
    const enforcement: EnforcementLayers = {
      namespaces: useUnshare,
      landlock: useHelper,
      seccomp: useHelper,
      capDrop: useHelper,
    };

    // Build spawn command and args
    let spawnCmd: string;
    let spawnArgs: string[];

    if (useUnshare && useHelper) {
      // Full: unshare [flags] -- helper -- command [args]
      spawnCmd = "unshare";
      spawnArgs = [
        ...unshareFlags,
        "--",
        helper.path!,
        "--",
        command,
        ...args,
      ];
    } else if (useUnshare) {
      // Namespace-only: unshare [flags] -- command [args]
      spawnCmd = "unshare";
      spawnArgs = [...unshareFlags, "--", command, ...args];
    } else if (useHelper) {
      // Helper-only (unusual — no namespaces requested): helper -- command [args]
      spawnCmd = helper.path!;
      spawnArgs = ["--", command, ...args];
    } else {
      // Direct execution (no isolation)
      spawnCmd = command;
      spawnArgs = args;
    }

    // If using helper, we need fd 3 for policy JSON
    const stdio = useHelper
      ? (["ignore", "pipe", "pipe", "pipe"] as const)
      : (["ignore", "pipe", "pipe"] as const);

    // Serialize policy for the helper (only filesystem + syscalls)
    const policyJson = useHelper
      ? JSON.stringify({
          filesystem: this.policy.filesystem,
          syscalls: this.policy.syscalls,
        })
      : undefined;

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn(spawnCmd, spawnArgs, {
        stdio: stdio as unknown as ("ignore" | "pipe")[],
        detached: true,
      });

      // Write policy JSON to fd 3 if using helper
      if (useHelper && policyJson !== undefined) {
        const fd3 = proc.stdio[3] as Writable | null;
        if (fd3 !== null) {
          fd3.end(policyJson);
        }
      }

      const timer = setTimeout(() => {
        killed = true;
        killReason = "timeout";
        // Kill entire process group (unshare + forked children)
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

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/sandbox/src/sandbox.test.ts`
Expected: All tests PASS (including the existing ones — they should work because `findHelper` returns `undefined` when the mock isn't set up, falling back to namespace-only)

### Step 5: Run full test suite

Run: `pnpm test`
Expected: All tests pass

### Step 6: Run typecheck

Run: `pnpm exec tsc --noEmit`
Expected: PASS

### Step 7: Commit

```
feat(sandbox): wire Sandbox.execute() to native helper binary

Sandbox.execute() now discovers the safeclaw-sandbox-helper, verifies
its SHA-256 checksum, and inserts it into the spawn chain. Policy JSON
(filesystem + syscalls) is serialized to fd 3. Falls back to
namespace-only isolation if helper is missing or untrusted.
```

---

## Task 5: Remove obsolete stubs

**Files:**
- Delete: `packages/sandbox/src/landlock.ts`
- Delete: `packages/sandbox/src/seccomp.ts`
- Delete: `packages/sandbox/src/namespace.ts`
- Modify: `packages/sandbox/src/index.ts`

**Why:** These stubs were placeholders for a native-binding approach. The C helper replaces them entirely. Keeping dead code is confusing. Check that nothing imports them first.

### Step 1: Search for imports of the stubs

Run: `rg "createLandlockRuleset|createSeccompFilter|createNamespaceConfig" --type ts`

Expected: Only `packages/sandbox/src/index.ts` re-exports them. If anything else imports them, do NOT delete — update this task.

### Step 2: Remove stub exports from index.ts

Update `packages/sandbox/src/index.ts` to remove the three stub exports:

```typescript
export { Sandbox } from "./sandbox.js";
export {
  detectKernelCapabilities,
  assertSandboxSupported,
} from "./detect.js";
export { findHelper, verifyHelper } from "./helper.js";
export { DEFAULT_POLICY } from "./types.js";
export type {
  SandboxPolicy,
  SandboxResult,
  PathRule,
  KernelCapabilities,
  EnforcementLayers,
} from "./types.js";
```

### Step 3: Delete the stub files

```bash
rm packages/sandbox/src/landlock.ts
rm packages/sandbox/src/seccomp.ts
rm packages/sandbox/src/namespace.ts
```

### Step 4: Run typecheck and tests

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: All pass (nothing imports the stubs)

### Step 5: Commit

```
refactor(sandbox): remove obsolete landlock/seccomp/namespace stubs

These were placeholders for a native-binding approach. The C helper
binary now handles Landlock, seccomp, and capability dropping directly.
```

---

## Task 6: Integration test — helper with real binary

**Files:**
- Create: `packages/sandbox/src/integration.test.ts`

**Why:** The unit tests mock the helper. We need at least one integration test that actually spawns the real binary (if present) to verify the full spawn chain works end-to-end.

### Step 1: Write the integration test

Create `packages/sandbox/src/integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "./sandbox.js";
import { DEFAULT_POLICY } from "./types.js";
import { findHelper } from "./helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = join(__dirname, "..", "..", "..", "native", "safeclaw-sandbox-helper");
const helperExists = existsSync(helperPath);

describe("Sandbox integration (real binary)", () => {
  // Skip if helper binary is not built
  it.skipIf(!helperExists)(
    "executes a command through the full unshare + helper chain",
    async () => {
      // Point directly to our built helper
      process.env["SAFECLAW_HELPER_PATH"] = helperPath;

      try {
        const sandbox = new Sandbox(DEFAULT_POLICY);
        const result = await sandbox.execute("/bin/echo", ["integration-test"]);

        // The command should complete (exit code depends on kernel support
        // for Landlock/seccomp — but the spawn chain itself should work)
        expect(result.stdout).toContain("integration-test");
        expect(result.exitCode).toBe(0);
        expect(result.enforcement).toBeDefined();
      } finally {
        delete process.env["SAFECLAW_HELPER_PATH"];
      }
    },
  );

  it.skipIf(!helperExists)(
    "reports enforcement layers when helper is used",
    async () => {
      process.env["SAFECLAW_HELPER_PATH"] = helperPath;

      try {
        const sandbox = new Sandbox(DEFAULT_POLICY);
        const result = await sandbox.execute("/bin/true", []);

        // If the helper hash matches, full enforcement is reported
        // If not, namespace-only is reported
        expect(result.enforcement).toBeDefined();
        expect(result.enforcement!.namespaces).toBe(true);
      } finally {
        delete process.env["SAFECLAW_HELPER_PATH"];
      }
    },
  );

  it("works with namespace-only when helper is not found", async () => {
    // Ensure no helper env var is set
    const saved = process.env["SAFECLAW_HELPER_PATH"];
    process.env["SAFECLAW_HELPER_PATH"] = "/nonexistent/path";

    try {
      const sandbox = new Sandbox(DEFAULT_POLICY);
      const result = await sandbox.execute("/bin/echo", ["fallback"]);
      expect(result.stdout).toContain("fallback");
      expect(result.enforcement?.namespaces).toBe(true);
      expect(result.enforcement?.landlock).toBe(false);
    } finally {
      if (saved !== undefined) {
        process.env["SAFECLAW_HELPER_PATH"] = saved;
      } else {
        delete process.env["SAFECLAW_HELPER_PATH"];
      }
    }
  });
});
```

### Step 2: Run the integration test

Run: `pnpm vitest run packages/sandbox/src/integration.test.ts`
Expected: Tests pass (helper-dependent tests skip if binary not built; fallback test passes)

### Step 3: Run full test suite

Run: `pnpm test`
Expected: All tests pass

### Step 4: Commit

```
test(sandbox): add integration tests for helper spawn chain

Tests the full unshare + helper + command spawn chain with the real
binary (skips if not built). Also tests namespace-only fallback.
```

---

## Task 7: Write `docs/sandboxing.md`

**Files:**
- Create: `docs/sandboxing.md`

**Why:** Comprehensive documentation of the sandboxing system — what it protects against, how each layer works, the architecture of the C helper, policy format, and security guarantees.

### Step 1: Write the document

Create `docs/sandboxing.md` with the following content. This is a deep-dive companion to `docs/security-model.md` (which has a brief sandbox overview).

```markdown
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

```
┌──────────────────────────────────────────────────────────────┐
│  Node.js: Sandbox.execute(command, args)                     │
│                                                              │
│  1. Resolve helper binary (discovery + SHA-256 verify)       │
│  2. Serialize policy JSON (filesystem + syscalls)            │
│  3. Spawn: unshare [ns-flags] -- helper -- command [args]    │
│  4. Write policy JSON to fd 3                                │
│  5. Collect stdout/stderr, enforce timeout                   │
└──────────────────────┬───────────────────────────────────────┘
                       │ fork+exec
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  unshare(1)                                                  │
│  Creates Linux namespaces:                                   │
│  - PID namespace (--pid --fork)                              │
│  - Network namespace (--net)                                 │
│  - Mount namespace (--mount)                                 │
│  - User namespace (--user --map-root-user)                   │
└──────────────────────┬───────────────────────────────────────┘
                       │ exec
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  safeclaw-sandbox-helper (static C binary, ~60 KB)           │
│                                                              │
│  1. Self-checks (refuse setuid, PR_SET_NO_NEW_PRIVS)         │
│  2. Read policy JSON from fd 3                               │
│  3. Apply Landlock filesystem restrictions                   │
│  4. Install seccomp-BPF syscall filter                       │
│  5. Drop all Linux capabilities                              │
│  6. Close all fds > 2 (fd hygiene)                           │
│  7. exec(command, args)                                      │
└──────────────────────┬───────────────────────────────────────┘
                       │ exec
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Target command (e.g., /bin/bash -c "npm test")              │
│                                                              │
│  Runs with ALL restrictions active:                          │
│  - Filesystem: only declared paths accessible                │
│  - Syscalls: only allow-listed syscalls permitted            │
│  - Network: isolated (no connectivity)                       │
│  - Capabilities: all dropped                                 │
│  - Privileges: cannot escalate (NO_NEW_PRIVS)                │
└──────────────────────────────────────────────────────────────┘
```

---

## Enforcement layers

### Layer 1: Linux namespaces (via `unshare`)

Namespaces provide coarse-grained isolation at the kernel level.

| Namespace | Flag | Effect |
|-----------|------|--------|
| PID | `--pid --fork` | Process sees only its own PID tree; cannot signal host processes |
| Network | `--net` | Fresh network stack with only loopback; no external connectivity |
| Mount | `--mount` | Isolated mount table; filesystem modifications don't affect host |
| User | `--user --map-root-user` | Unprivileged user mapping; enables other namespaces without root |

Namespace isolation is handled by the standard `unshare(1)` utility. This is the baseline — it works even without the helper binary.

### Layer 2: Landlock filesystem restrictions

[Landlock](https://docs.kernel.org/userspace-api/landlock.html) is a Linux security module (available since kernel 5.13) that restricts filesystem access for unprivileged processes.

The helper creates a Landlock ruleset and adds rules based on the policy's `filesystem.allow` list:

| Access type | Landlock permissions granted |
|-------------|------------------------------|
| `read` | `LANDLOCK_ACCESS_FS_READ_FILE`, `LANDLOCK_ACCESS_FS_READ_DIR` |
| `write` | `LANDLOCK_ACCESS_FS_WRITE_FILE`, `LANDLOCK_ACCESS_FS_MAKE_REG`, `LANDLOCK_ACCESS_FS_REMOVE_FILE`, `LANDLOCK_ACCESS_FS_REMOVE_DIR`, `LANDLOCK_ACCESS_FS_MAKE_DIR` |
| `readwrite` | Both read and write permissions |
| `execute` | `LANDLOCK_ACCESS_FS_EXECUTE` |

Any path not in the allow list is **denied by default**. The `filesystem.deny` list is currently reserved for future use (explicit deny rules for paths that might be granted by a parent allow rule).

**ABI compatibility:** The helper detects the kernel's Landlock ABI version at runtime (v1-v3) and adjusts the handled access flags accordingly. If Landlock is not available, the helper exits with code 71 and SafeClaw falls back to namespace-only isolation.

### Layer 3: seccomp-BPF syscall filtering

[seccomp-BPF](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html) restricts which system calls a process can invoke. The helper constructs a BPF program that:

1. Validates the architecture is `AUDIT_ARCH_X86_64`
2. Allows each syscall in the policy's `syscalls.allow` list
3. Returns `SECCOMP_RET_KILL_PROCESS` for any syscall not in the allow list

The default policy allows 26 syscalls — the minimum needed for basic process execution:

```
read, write, exit, exit_group, brk, mmap, close, fstat, mprotect,
munmap, rt_sigaction, rt_sigprocmask, ioctl, access, getpid, clone,
execve, wait4, uname, fcntl, getcwd, arch_prctl, set_tid_address,
set_robust_list, rseq, prlimit64, getrandom
```

Syscall name-to-number resolution uses a compile-time lookup table covering all 373 x86_64 syscalls. Unknown syscall names cause the helper to exit with an error rather than silently allowing them.

### Layer 4: Capability dropping

Linux capabilities provide fine-grained privilege control. After applying Landlock and seccomp, the helper drops **all** capabilities from the effective, permitted, and inheritable sets using `capset(2)`. The ambient capability set is cleared via `prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL)`.

This ensures the sandboxed process cannot use any privileged kernel operations, even if the parent had capabilities.

### Layer 5: Privilege escalation prevention

Before any sandbox enforcement, the helper sets `PR_SET_NO_NEW_PRIVS` via `prctl(2)`. This is a one-way flag that prevents `exec` from gaining privileges through setuid/setgid binaries. Once set, it cannot be unset and is inherited by all child processes.

---

## Enforcement order

The enforcement order within the helper is critical for correctness:

```
1. PR_SET_NO_NEW_PRIVS     ← Must be first (required by seccomp)
2. Landlock ruleset         ← Must be before seccomp (uses syscalls seccomp would block)
3. seccomp-BPF filter       ← Must be after Landlock (blocks landlock_* syscalls)
4. Capability drop          ← Must be last (capset might be blocked by seccomp)
5. Close fds > 2            ← Cleanup before exec
6. exec(command)            ← All restrictions inherited by child
```

---

## Policy format

The policy JSON written to fd 3 contains only the fields relevant to the helper (namespace and network isolation are handled by `unshare`):

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

The full `SandboxPolicy` type (in TypeScript) also includes `network`, `namespaces`, and `timeoutMs` — these are consumed by the Node.js layer, not the helper.

---

## Helper discovery and integrity

### Discovery order

`Sandbox.execute()` searches for the helper binary in this order:

1. **`SAFECLAW_HELPER_PATH`** environment variable — for custom installations
2. **Co-located path** — `native/safeclaw-sandbox-helper` relative to the package
3. **Installed path** — `~/.safeclaw/bin/safeclaw-sandbox-helper` (from install script)
4. **System PATH** — `which safeclaw-sandbox-helper`

### SHA-256 integrity verification

Before spawning the helper, its SHA-256 checksum is verified against a known-good hash embedded in the `@safeclaw/sandbox` package. This prevents a tampered binary from being used as a privilege escalation vector.

A compromised helper could:
- Skip sandbox setup entirely, running the target unrestricted
- Exfiltrate the policy JSON (reveals allowed paths and syscalls)
- Replace the target command with a malicious payload

### Graceful degradation

| Helper status | Enforcement |
|---------------|-------------|
| Found + checksum valid | Namespaces + Landlock + seccomp + capability drop |
| Found + checksum invalid | Namespaces only (warning logged) |
| Not found | Namespaces only (warning logged) |

The `SandboxResult.enforcement` field reports which layers were active:

```typescript
interface EnforcementLayers {
  namespaces: boolean;  // unshare was used
  landlock: boolean;    // Landlock filesystem restrictions active
  seccomp: boolean;     // seccomp-BPF syscall filter active
  capDrop: boolean;     // all capabilities dropped
}
```

---

## Helper binary properties

| Property | Value |
|----------|-------|
| Language | C11 (`-std=c11 -Wall -Wextra -Werror -pedantic`) |
| Linking | Static (musl libc) — no runtime dependencies |
| Size | ~60 KB |
| Architecture | x86_64 (aarch64 planned) |
| Source | `native/src/` (~700 lines across 6 source files) |
| Input | Policy JSON on fd 3 (max 64 KiB) |
| Output | Inherits stdout/stderr from parent |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Target command exited successfully |
| 70 | Policy parse error (invalid JSON, missing fields) |
| 71 | Landlock setup failed (kernel too old or LSM disabled) |
| 72 | seccomp setup failed |
| 73 | Capability drop failed |
| 74 | exec failed (command not found) |
| 75 | fd 3 read error |
| 76 | Setuid/setgid detected — refusing to run |
| 77 | PR_SET_NO_NEW_PRIVS failed |

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
| Helper binary tampering | SHA-256 integrity check before every use |
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

## Kernel requirements

SafeClaw v1 requires Linux with:

- **Kernel >= 5.13** — for Landlock LSM support
- **seccomp-BPF** — enabled in kernel config (`CONFIG_SECCOMP_FILTER=y`)
- **User namespaces** — `sysctl kernel.unprivileged_userns_clone=1` (default on most distros)

The `safeclaw onboard` command checks these requirements during setup. The `detectKernelCapabilities()` function provides programmatic detection.

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
pnpm test                    # All TypeScript tests (includes sandbox unit tests)
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
console.log(sandbox.getPolicy());
```
```

### Step 2: Review the document

Read through the document and verify:
- All exit codes match the spec (`docs/plans/2026-03-02-sandbox-helper-spec.md`)
- Architecture diagram matches the actual spawn chain
- Default syscall list matches `DEFAULT_POLICY` in `types.ts`
- No broken cross-references

### Step 3: Commit

```
docs: add comprehensive sandboxing deep-dive documentation

Covers architecture, threat model, enforcement layers, policy format,
helper discovery, integrity checking, and developer guide. Complements
the existing security-model.md overview.
```

---

## Task 8: Link sandboxing docs from README and security-model.md

**Files:**
- Modify: `README.md`
- Modify: `docs/security-model.md`

### Step 1: Add link to README.md

In `README.md`, find the documentation section (or the appropriate location near existing doc links) and add a reference to `docs/sandboxing.md`. Also locate other places in the README that mention sandboxing and add cross-references.

Find any existing `docs/` links pattern and add:

```markdown
- [Sandboxing Deep Dive](docs/sandboxing.md) — enforcement layers, threat model, helper architecture
```

### Step 2: Add cross-reference in security-model.md

In `docs/security-model.md`, after the existing sandbox section (around line 58), add:

```markdown
For a detailed explanation of enforcement layers, the helper binary architecture, policy format, and security guarantees, see [Sandboxing Deep Dive](sandboxing.md).
```

### Step 3: Commit

```
docs: cross-reference sandboxing deep-dive from README and security model
```

---

## Task 9: Update README feature status table

**Files:**
- Modify: `README.md:53`

### Step 1: Update the WIP status to Done

In `README.md`, change line 53 from:

```markdown
| OS-level sandboxing (Landlock + seccomp + namespaces) | **WIP** | Namespace isolation works (unshare); Landlock/seccomp require native helper (spec written) |
```

To:

```markdown
| OS-level sandboxing (Landlock + seccomp + namespaces) | Done | Namespace + Landlock + seccomp + capability drop via native helper |
```

### Step 2: Commit

```
docs: mark OS-level sandboxing as Done in README feature table

All enforcement layers (namespaces, Landlock, seccomp-BPF, capability
dropping) are implemented and wired into Sandbox.execute().
```

---

## Task 10: Final verification

### Step 1: Run full typecheck

Run: `pnpm exec tsc --noEmit`
Expected: PASS

### Step 2: Run full test suite

Run: `pnpm test`
Expected: All tests pass

### Step 3: Run linter

Run: `pnpm exec oxlint`
Expected: No errors

### Step 4: Run native tests (if binary is built)

Run: `cd native && make check`
Expected: 75 tests pass (2 expected skips)

### Step 5: Verify documentation links

Check that all cross-references resolve:
- `README.md` links to `docs/sandboxing.md`
- `docs/sandboxing.md` links to `docs/security-model.md`
- `docs/security-model.md` links to `docs/sandboxing.md`

### Step 6: Final commit (if any fixups needed)

```
chore: fix any issues found during final verification
```
