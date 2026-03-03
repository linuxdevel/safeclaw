# Doctor Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `safeclaw doctor` CLI command that runs diagnostic checks and reports system health, configuration status, and potential issues — without requiring vault or bootstrap.

**Architecture:** Create a `DiagnosticRunner` in `packages/cli/src/commands/` that runs a series of `DiagnosticCheck` functions. Each check returns `pass`/`warn`/`fail` with a human-readable message. The `runDoctor()` entry point collects all results, formats them with coloured status indicators, and prints a summary line. Exit code is 0 if all checks pass or warn, 1 if any fail. The command is intentionally decoupled from bootstrap — it checks prerequisites, not runtime state.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs`, Vitest

---

### Task 1: Define diagnostic types

**Files:**
- Create: `packages/cli/src/commands/doctor-types.ts`

**Step 1: Create the types file**

```typescript
/**
 * A single diagnostic check. Each check is a standalone function
 * that probes one aspect of the system and returns a result.
 */
export interface DiagnosticCheck {
  /** Short identifier shown in the report (e.g. "node-version") */
  name: string;
  /** Grouping category for display */
  category: "system" | "security" | "config" | "connectivity";
  /** Execute the check and return a result */
  run(): Promise<DiagnosticResult>;
}

/**
 * Result of a single diagnostic check.
 */
export interface DiagnosticResult {
  /** pass = OK, warn = non-fatal issue, fail = blocking problem */
  status: "pass" | "warn" | "fail";
  /** One-line human-readable summary */
  message: string;
  /** Optional multi-line detail (shown on warn/fail) */
  detail?: string | undefined;
}
```

**Step 2: Commit**

```bash
git add packages/cli/src/commands/doctor-types.ts
git commit -m "feat(cli): add DiagnosticCheck and DiagnosticResult types"
```

---

### Task 2: Create individual check functions — system checks

**Files:**
- Create: `packages/cli/src/commands/doctor-checks.ts`
- Create: `packages/cli/src/commands/doctor-checks.test.ts`

This task implements the first group of checks: `nodeVersionCheck`, `linuxCheck`, `architectureCheck`. Each check is a factory function that returns a `DiagnosticCheck`, with OS/version dependencies injectable for testing.

**Step 1: Write the failing tests**

In `packages/cli/src/commands/doctor-checks.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  nodeVersionCheck,
  linuxCheck,
  architectureCheck,
} from "./doctor-checks.js";

describe("nodeVersionCheck", () => {
  it("passes when Node.js >= 22", async () => {
    const check = nodeVersionCheck({ version: "v22.3.0" });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("22.3.0");
  });

  it("fails when Node.js < 22", async () => {
    const check = nodeVersionCheck({ version: "v20.11.0" });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("20.11.0");
    expect(result.detail).toContain("22");
  });
});

describe("linuxCheck", () => {
  it("passes on linux", async () => {
    const check = linuxCheck({ platform: "linux" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails on non-linux", async () => {
    const check = linuxCheck({ platform: "darwin" });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("darwin");
  });
});

describe("architectureCheck", () => {
  it("passes on x64", async () => {
    const check = architectureCheck({ arch: "x64" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("passes on arm64", async () => {
    const check = architectureCheck({ arch: "arm64" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails on unsupported architecture", async () => {
    const check = architectureCheck({ arch: "ia32" });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ia32");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: FAIL — module `./doctor-checks.js` not found

**Step 3: Write the implementation**

In `packages/cli/src/commands/doctor-checks.ts`:

```typescript
import type { DiagnosticCheck, DiagnosticResult } from "./doctor-types.js";

// ---------------------------------------------------------------------------
// System checks
// ---------------------------------------------------------------------------

export interface NodeVersionDeps {
  version: string;
}

export function nodeVersionCheck(
  deps: NodeVersionDeps = { version: process.version },
): DiagnosticCheck {
  return {
    name: "node-version",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      // process.version is "vX.Y.Z"
      const raw = deps.version.replace(/^v/, "");
      const major = parseInt(raw.split(".")[0] ?? "0", 10);
      if (major >= 22) {
        return { status: "pass", message: `Node.js ${raw}` };
      }
      return {
        status: "fail",
        message: `Node.js ${raw} is too old`,
        detail: "SafeClaw requires Node.js >= 22.",
      };
    },
  };
}

export interface PlatformDeps {
  platform: string;
}

export function linuxCheck(
  deps: PlatformDeps = { platform: process.platform },
): DiagnosticCheck {
  return {
    name: "linux",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      if (deps.platform === "linux") {
        return { status: "pass", message: "Running on Linux" };
      }
      return {
        status: "fail",
        message: `Running on ${deps.platform}`,
        detail: "SafeClaw requires Linux.",
      };
    },
  };
}

export interface ArchDeps {
  arch: string;
}

export function architectureCheck(
  deps: ArchDeps = { arch: process.arch },
): DiagnosticCheck {
  const supported = new Set(["x64", "arm64"]);
  return {
    name: "architecture",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      if (supported.has(deps.arch)) {
        return { status: "pass", message: `Architecture: ${deps.arch}` };
      }
      return {
        status: "fail",
        message: `Unsupported architecture: ${deps.arch}`,
        detail: "SafeClaw supports x86_64 (x64) and arm64 only.",
      };
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: 7 tests PASS

**Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor-checks.ts packages/cli/src/commands/doctor-checks.test.ts
git commit -m "feat(cli): add system diagnostic checks (node, linux, arch)"
```

---

### Task 3: Add security checks — vault, sandbox helper, unshare

**Files:**
- Modify: `packages/cli/src/commands/doctor-checks.ts`
- Modify: `packages/cli/src/commands/doctor-checks.test.ts`

**Step 1: Write the failing tests**

Append to `packages/cli/src/commands/doctor-checks.test.ts`:

```typescript
import {
  vaultExistsCheck,
  sandboxHelperCheck,
  unshareCheck,
} from "./doctor-checks.js";

describe("vaultExistsCheck", () => {
  it("passes when vault file exists", async () => {
    const check = vaultExistsCheck({ existsSync: () => true, homedir: "/home/test" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("warns when vault file does not exist", async () => {
    const check = vaultExistsCheck({ existsSync: () => false, homedir: "/home/test" });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("onboard");
  });
});

describe("sandboxHelperCheck", () => {
  it("passes when helper is found and executable", async () => {
    const check = sandboxHelperCheck({ findHelper: () => "/usr/bin/safeclaw-sandbox-helper" });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("/usr/bin/safeclaw-sandbox-helper");
  });

  it("warns when helper is not found", async () => {
    const check = sandboxHelperCheck({ findHelper: () => undefined });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("native");
  });
});

describe("unshareCheck", () => {
  it("passes when unshare is available", async () => {
    const check = unshareCheck({ execFileSync: () => "/usr/bin/unshare\n" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when unshare is not found", async () => {
    const check = unshareCheck({
      execFileSync: () => { throw new Error("not found"); },
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("unshare");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: FAIL — named exports not found

**Step 3: Write the implementation**

Append to `packages/cli/src/commands/doctor-checks.ts`:

```typescript
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";
import { execFileSync as defaultExecFileSync } from "node:child_process";
import { findHelper as defaultFindHelper } from "@safeclaw/sandbox/helper";
```

Wait — `findHelper` is not exported from `@safeclaw/sandbox` index. Check the sandbox barrel: it exports `Sandbox`, `detectKernelCapabilities`, `assertSandboxSupported`, `DEFAULT_POLICY`, and types. `findHelper` is an internal module. We should NOT reach into internal modules. Instead, inject it.

Update the import to avoid internal module access. The doctor checks will accept `findHelper` as a dependency:

Add these imports at the top of `doctor-checks.ts` (after the existing import):

```typescript
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";
import { execFileSync as defaultExecFileSync } from "node:child_process";
```

Then add the check implementations:

```typescript
// ---------------------------------------------------------------------------
// Config checks
// ---------------------------------------------------------------------------

export interface VaultExistsDeps {
  existsSync: (path: string) => boolean;
  homedir: string;
}

export function vaultExistsCheck(
  deps: VaultExistsDeps = {
    existsSync: defaultExistsSync,
    homedir: defaultHomedir(),
  },
): DiagnosticCheck {
  return {
    name: "vault-exists",
    category: "config",
    async run(): Promise<DiagnosticResult> {
      const vaultPath = join(deps.homedir, ".safeclaw", "vault.json");
      if (deps.existsSync(vaultPath)) {
        return { status: "pass", message: `Vault found: ${vaultPath}` };
      }
      return {
        status: "warn",
        message: "Vault not found",
        detail: `Expected at ${vaultPath}. Run 'safeclaw onboard' to create it.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

export interface SandboxHelperDeps {
  findHelper: () => string | undefined;
}

export function sandboxHelperCheck(
  deps: SandboxHelperDeps = { findHelper: defaultFindHelper },
): DiagnosticCheck {
  return {
    name: "sandbox-helper",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      const helperPath = deps.findHelper();
      if (helperPath !== undefined) {
        return {
          status: "pass",
          message: `Sandbox helper: ${helperPath}`,
        };
      }
      return {
        status: "warn",
        message: "Sandbox helper not found",
        detail:
          "The native sandbox helper binary is not installed. " +
          "Run 'make -C native' to build it, or sandbox enforcement will be limited.",
      };
    },
  };
}

export interface UnshareDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function unshareCheck(
  deps: UnshareDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "unshare",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        deps.execFileSync("which", ["unshare"]);
        return { status: "pass", message: "unshare command available" };
      } catch {
        return {
          status: "fail",
          message: "unshare command not found",
          detail:
            "The 'unshare' command is required for namespace isolation. " +
            "Install util-linux: apt install util-linux",
        };
      }
    },
  };
}
```

Note about `defaultFindHelper`: since `findHelper` is not publicly exported from `@safeclaw/sandbox`, we need to import it from the internal path. In the **actual implementation**, import it as:

```typescript
import { findHelper as defaultFindHelper } from "@safeclaw/sandbox/helper";
```

This works because vitest's module alias resolves `@safeclaw/sandbox` to the source. However, this bypasses the barrel export. If the team prefers, add `findHelper` to `packages/sandbox/src/index.ts` exports first. The safer approach: **add the export to the sandbox barrel** in a prior step.

**Alternative (preferred):** Add `findHelper` to the sandbox barrel exports. In `packages/sandbox/src/index.ts`, add:

```typescript
export { findHelper } from "./helper.js";
```

Then import in `doctor-checks.ts`:

```typescript
import { findHelper as defaultFindHelper } from "@safeclaw/sandbox";
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: 13 tests PASS

**Step 5: Commit**

```bash
git add packages/sandbox/src/index.ts packages/cli/src/commands/doctor-checks.ts packages/cli/src/commands/doctor-checks.test.ts
git commit -m "feat(cli): add vault, sandbox-helper, and unshare checks"
```

---

### Task 4: Add kernel security checks — Landlock, seccomp, user namespaces

**Files:**
- Modify: `packages/cli/src/commands/doctor-checks.ts`
- Modify: `packages/cli/src/commands/doctor-checks.test.ts`

**Step 1: Write the failing tests**

Append to `packages/cli/src/commands/doctor-checks.test.ts`:

```typescript
import {
  landlockCheck,
  seccompCheck,
  userNamespaceCheck,
} from "./doctor-checks.js";
import type { KernelCapabilities } from "@safeclaw/sandbox";

function makeKernelCaps(overrides: Partial<KernelCapabilities> = {}): KernelCapabilities {
  return {
    landlock: { supported: true, abiVersion: 3 },
    seccomp: { supported: true },
    namespaces: { user: true, pid: true, net: true, mnt: true },
    ...overrides,
  };
}

describe("landlockCheck", () => {
  it("passes when Landlock is supported", async () => {
    const caps = makeKernelCaps();
    const check = landlockCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("ABI v3");
  });

  it("fails when Landlock is not supported", async () => {
    const caps = makeKernelCaps({ landlock: { supported: false, abiVersion: 0 } });
    const check = landlockCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("5.13");
  });
});

describe("seccompCheck", () => {
  it("passes when seccomp is supported", async () => {
    const caps = makeKernelCaps();
    const check = seccompCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when seccomp is not supported", async () => {
    const caps = makeKernelCaps({ seccomp: { supported: false } });
    const check = seccompCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("fail");
  });
});

describe("userNamespaceCheck", () => {
  it("passes when user namespaces are available", async () => {
    const caps = makeKernelCaps();
    const check = userNamespaceCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when user namespaces are unavailable", async () => {
    const caps = makeKernelCaps({
      namespaces: { user: false, pid: true, net: true, mnt: true },
    });
    const check = userNamespaceCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("namespace");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: FAIL — named exports not found

**Step 3: Write the implementation**

Append to `packages/cli/src/commands/doctor-checks.ts`:

```typescript
import {
  detectKernelCapabilities as defaultDetectKernelCapabilities,
} from "@safeclaw/sandbox";
import type { KernelCapabilities } from "@safeclaw/sandbox";

export interface KernelCapsDeps {
  detectKernelCapabilities: () => KernelCapabilities;
}

const defaultKernelDeps: KernelCapsDeps = {
  detectKernelCapabilities: defaultDetectKernelCapabilities,
};

export function landlockCheck(
  deps: KernelCapsDeps = defaultKernelDeps,
): DiagnosticCheck {
  return {
    name: "landlock",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const caps = deps.detectKernelCapabilities();
        if (caps.landlock.supported) {
          return {
            status: "pass",
            message: `Landlock supported (ABI v${caps.landlock.abiVersion})`,
          };
        }
        return {
          status: "fail",
          message: "Landlock not supported",
          detail: "Landlock requires kernel >= 5.13.",
        };
      } catch {
        return {
          status: "fail",
          message: "Could not detect Landlock support",
          detail: "Failed to read kernel capabilities.",
        };
      }
    },
  };
}

export function seccompCheck(
  deps: KernelCapsDeps = defaultKernelDeps,
): DiagnosticCheck {
  return {
    name: "seccomp",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const caps = deps.detectKernelCapabilities();
        if (caps.seccomp.supported) {
          return { status: "pass", message: "seccomp-BPF supported" };
        }
        return {
          status: "fail",
          message: "seccomp-BPF not supported",
          detail: "seccomp is required for syscall filtering.",
        };
      } catch {
        return {
          status: "fail",
          message: "Could not detect seccomp support",
          detail: "Failed to read kernel capabilities.",
        };
      }
    },
  };
}

export function userNamespaceCheck(
  deps: KernelCapsDeps = defaultKernelDeps,
): DiagnosticCheck {
  return {
    name: "user-namespaces",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const caps = deps.detectKernelCapabilities();
        if (caps.namespaces.user) {
          return { status: "pass", message: "User namespaces available" };
        }
        return {
          status: "fail",
          message: "User namespaces unavailable",
          detail:
            "User namespace support is required for unprivileged sandbox isolation. " +
            "Check: sysctl kernel.unprivileged_userns_clone=1",
        };
      } catch {
        return {
          status: "fail",
          message: "Could not detect namespace support",
          detail: "Failed to read kernel capabilities.",
        };
      }
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: 19 tests PASS

**Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor-checks.ts packages/cli/src/commands/doctor-checks.test.ts
git commit -m "feat(cli): add kernel security checks (landlock, seccomp, namespaces)"
```

---

### Task 5: Add keyring, config file, and connectivity checks

**Files:**
- Modify: `packages/cli/src/commands/doctor-checks.ts`
- Modify: `packages/cli/src/commands/doctor-checks.test.ts`

**Step 1: Write the failing tests**

Append to `packages/cli/src/commands/doctor-checks.test.ts`:

```typescript
import {
  keyringCheck,
  configFileCheck,
  githubConnectivityCheck,
} from "./doctor-checks.js";

describe("keyringCheck", () => {
  it("passes when secret-tool is available", async () => {
    const check = keyringCheck({
      execFileSync: () => "/usr/bin/secret-tool\n",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("warns when secret-tool is not found", async () => {
    const check = keyringCheck({
      execFileSync: () => { throw new Error("not found"); },
    });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("passphrase");
  });
});

describe("configFileCheck", () => {
  it("passes when config file does not exist (optional)", async () => {
    const check = configFileCheck({
      existsSync: () => false,
      readFileSync: () => "",
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("not present");
  });

  it("passes when config file exists and is valid JSON", async () => {
    const check = configFileCheck({
      existsSync: () => true,
      readFileSync: () => '{ "model": "claude-sonnet-4" }',
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("valid");
  });

  it("fails when config file exists but is invalid JSON", async () => {
    const check = configFileCheck({
      existsSync: () => true,
      readFileSync: () => "{ broken json",
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("invalid");
  });

  it("fails when config file exists but is not an object", async () => {
    const check = configFileCheck({
      existsSync: () => true,
      readFileSync: () => '"just a string"',
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a JSON object");
  });
});

describe("githubConnectivityCheck", () => {
  it("passes when fetch succeeds", async () => {
    const check = githubConnectivityCheck({
      fetch: async () => ({ ok: true, status: 200 }) as Response,
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("warns when fetch fails", async () => {
    const check = githubConnectivityCheck({
      fetch: async () => { throw new Error("ENOTFOUND"); },
    });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("api.github.com");
  });

  it("warns when fetch returns non-OK status", async () => {
    const check = githubConnectivityCheck({
      fetch: async () => ({ ok: false, status: 503 }) as Response,
    });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("503");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: FAIL — named exports not found

**Step 3: Write the implementation**

Append to `packages/cli/src/commands/doctor-checks.ts`:

```typescript
// ---------------------------------------------------------------------------
// Connectivity checks
// ---------------------------------------------------------------------------

export interface KeyringDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function keyringCheck(
  deps: KeyringDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "keyring",
    category: "config",
    async run(): Promise<DiagnosticResult> {
      try {
        deps.execFileSync("which", ["secret-tool"]);
        return { status: "pass", message: "secret-tool (GNOME Keyring) available" };
      } catch {
        return {
          status: "warn",
          message: "secret-tool not found",
          detail:
            "GNOME Keyring integration unavailable. " +
            "Vault will fall back to passphrase-based key derivation. " +
            "Install: apt install libsecret-tools",
        };
      }
    },
  };
}

export interface ConfigFileDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  homedir: string;
}

export function configFileCheck(
  deps: ConfigFileDeps = {
    existsSync: defaultExistsSync,
    readFileSync: (p: string) =>
      defaultReadFileSync(p, "utf8"),
    homedir: defaultHomedir(),
  },
): DiagnosticCheck {
  return {
    name: "config-file",
    category: "config",
    async run(): Promise<DiagnosticResult> {
      const configPath = join(deps.homedir, ".safeclaw", "safeclaw.json");
      if (!deps.existsSync(configPath)) {
        return {
          status: "pass",
          message: "Config file not present (optional)",
        };
      }
      try {
        const content = deps.readFileSync(configPath);
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return {
            status: "fail",
            message: "Config file is not a JSON object",
            detail: `${configPath} must contain a JSON object.`,
          };
        }
        return {
          status: "pass",
          message: `Config file valid: ${configPath}`,
        };
      } catch (err) {
        return {
          status: "fail",
          message: "Config file contains invalid JSON",
          detail: `${configPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

export interface GithubConnectivityDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function githubConnectivityCheck(
  deps: GithubConnectivityDeps = { fetch: globalThis.fetch },
): DiagnosticCheck {
  return {
    name: "github-connectivity",
    category: "connectivity",
    async run(): Promise<DiagnosticResult> {
      try {
        const response = await deps.fetch("https://api.github.com", {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return { status: "pass", message: "GitHub API reachable" };
        }
        return {
          status: "warn",
          message: `GitHub API returned HTTP ${response.status}`,
          detail:
            "api.github.com is reachable but returned a non-OK status. " +
            "Copilot authentication may not work.",
        };
      } catch (err) {
        return {
          status: "warn",
          message: "Cannot reach GitHub API",
          detail:
            `Could not connect to api.github.com: ${err instanceof Error ? err.message : String(err)}. ` +
            "Copilot features require internet connectivity.",
        };
      }
    },
  };
}
```

Add the missing import at the top of the file (alongside the existing `fs` imports):

```typescript
import { readFileSync as defaultReadFileSync } from "node:fs";
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/doctor-checks.test.ts`
Expected: 28 tests PASS

**Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor-checks.ts packages/cli/src/commands/doctor-checks.test.ts
git commit -m "feat(cli): add keyring, config-file, and github-connectivity checks"
```

---

### Task 6: Create the runDoctor function and formatter

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Create: `packages/cli/src/commands/doctor.test.ts`

**Step 1: Write the failing tests**

In `packages/cli/src/commands/doctor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runDoctor } from "./doctor.js";
import type { DiagnosticCheck, DiagnosticResult } from "./doctor-types.js";

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function makeCheck(
  name: string,
  category: "system" | "security" | "config" | "connectivity",
  result: DiagnosticResult,
): DiagnosticCheck {
  return { name, category, run: async () => result };
}

describe("runDoctor", () => {
  it("returns exit code 0 when all checks pass", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "security", { status: "pass", message: "OK" }),
    ];
    const exitCode = await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(exitCode).toBe(0);
    expect(out).toContain("2 passed");
    expect(out).toContain("0 warnings");
    expect(out).toContain("0 failed");
  });

  it("returns exit code 0 when checks pass or warn", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "config", { status: "warn", message: "Missing", detail: "Install it" }),
    ];
    const exitCode = await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(exitCode).toBe(0);
    expect(out).toContain("1 passed");
    expect(out).toContain("1 warning");
    expect(out).toContain("0 failed");
  });

  it("returns exit code 1 when any check fails", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "system", { status: "fail", message: "Bad", detail: "Fix it" }),
    ];
    const exitCode = await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(exitCode).toBe(1);
    expect(out).toContain("1 passed");
    expect(out).toContain("1 failed");
  });

  it("displays check names and messages", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("node-version", "system", { status: "pass", message: "Node.js 22.3.0" }),
      makeCheck("vault", "config", { status: "warn", message: "Not found", detail: "Run onboard" }),
    ];
    await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(out).toContain("node-version");
    expect(out).toContain("Node.js 22.3.0");
    expect(out).toContain("vault");
    expect(out).toContain("Run onboard");
  });

  it("groups checks by category", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "security", { status: "pass", message: "OK" }),
      makeCheck("c", "config", { status: "pass", message: "OK" }),
      makeCheck("d", "connectivity", { status: "pass", message: "OK" }),
    ];
    await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(out).toContain("System");
    expect(out).toContain("Security");
    expect(out).toContain("Config");
    expect(out).toContain("Connectivity");
  });

  it("shows detail for warn and fail but not pass", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK", detail: "hidden detail" }),
      makeCheck("b", "system", { status: "warn", message: "Hmm", detail: "shown detail" }),
    ];
    await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(out).not.toContain("hidden detail");
    expect(out).toContain("shown detail");
  });

  it("handles empty checks array", async () => {
    const output = new PassThrough();
    const exitCode = await runDoctor({ output, checks: [] });
    const out = readOutput(output);

    expect(exitCode).toBe(0);
    expect(out).toContain("0 passed");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/doctor.test.ts`
Expected: FAIL — module `./doctor.js` not found

**Step 3: Write the implementation**

In `packages/cli/src/commands/doctor.ts`:

```typescript
import type { DiagnosticCheck, DiagnosticResult } from "./doctor-types.js";
import {
  nodeVersionCheck,
  linuxCheck,
  architectureCheck,
  vaultExistsCheck,
  sandboxHelperCheck,
  unshareCheck,
  landlockCheck,
  seccompCheck,
  userNamespaceCheck,
  keyringCheck,
  configFileCheck,
  githubConnectivityCheck,
} from "./doctor-checks.js";

// ---------------------------------------------------------------------------
// ANSI colour helpers (disabled when NO_COLOR is set or output is not a TTY)
// ---------------------------------------------------------------------------

function supportsColor(output: NodeJS.WritableStream): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if ("isTTY" in output && (output as NodeJS.WriteStream).isTTY) return true;
  return false;
}

interface StatusStyle {
  symbol: string;
  color: (s: string) => string;
}

function statusStyles(colorEnabled: boolean): Record<DiagnosticResult["status"], StatusStyle> {
  if (!colorEnabled) {
    return {
      pass: { symbol: "[PASS]", color: (s) => s },
      warn: { symbol: "[WARN]", color: (s) => s },
      fail: { symbol: "[FAIL]", color: (s) => s },
    };
  }
  return {
    pass: { symbol: "\x1b[32m✓\x1b[0m", color: (s) => `\x1b[32m${s}\x1b[0m` },
    warn: { symbol: "\x1b[33m!\x1b[0m", color: (s) => `\x1b[33m${s}\x1b[0m` },
    fail: { symbol: "\x1b[31m✗\x1b[0m", color: (s) => `\x1b[31m${s}\x1b[0m` },
  };
}

// ---------------------------------------------------------------------------
// Category display order
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: DiagnosticCheck["category"][] = [
  "system",
  "security",
  "config",
  "connectivity",
];

const CATEGORY_LABELS: Record<DiagnosticCheck["category"], string> = {
  system: "System",
  security: "Security",
  config: "Config",
  connectivity: "Connectivity",
};

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  output: NodeJS.WritableStream;
  /** Override the default checks (useful for testing) */
  checks?: DiagnosticCheck[];
}

/**
 * Run all diagnostic checks and print a formatted report.
 * Returns 0 if all checks pass or warn, 1 if any check fails.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const { output } = options;
  const checks = options.checks ?? createDefaultChecks();
  const colorEnabled = supportsColor(output);
  const styles = statusStyles(colorEnabled);

  function print(msg: string): void {
    output.write(msg + "\n");
  }

  print("");
  print("SafeClaw Doctor");
  print("===============");
  print("");

  // Run all checks and collect results
  const results: Array<{
    check: DiagnosticCheck;
    result: DiagnosticResult;
  }> = [];

  for (const check of checks) {
    const result = await check.run();
    results.push({ check, result });
  }

  // Group by category
  const grouped = new Map<string, typeof results>();
  for (const entry of results) {
    const cat = entry.check.category;
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push(entry);
  }

  // Print by category in fixed order
  for (const category of CATEGORY_ORDER) {
    const entries = grouped.get(category);
    if (!entries || entries.length === 0) continue;

    print(`--- ${CATEGORY_LABELS[category]} ---`);
    for (const { check, result } of entries) {
      const style = styles[result.status];
      print(`  ${style.symbol} ${check.name}: ${result.message}`);
      if (result.detail && result.status !== "pass") {
        print(`    ${result.detail}`);
      }
    }
    print("");
  }

  // Summary
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  for (const { result } of results) {
    if (result.status === "pass") passed++;
    else if (result.status === "warn") warnings++;
    else failed++;
  }

  const summary = [
    `${passed} passed`,
    `${warnings} warning${warnings === 1 ? "" : "s"}`,
    `${failed} failed`,
  ].join(", ");

  print(`Summary: ${summary}`);

  return failed > 0 ? 1 : 0;
}

/**
 * Create the default set of diagnostic checks.
 * Each check uses real system dependencies (no injection).
 */
export function createDefaultChecks(): DiagnosticCheck[] {
  return [
    // System
    nodeVersionCheck(),
    linuxCheck(),
    architectureCheck(),
    // Security
    unshareCheck(),
    landlockCheck(),
    seccompCheck(),
    userNamespaceCheck(),
    sandboxHelperCheck(),
    // Config
    vaultExistsCheck(),
    keyringCheck(),
    configFileCheck(),
    // Connectivity
    githubConnectivityCheck(),
  ];
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/doctor.test.ts`
Expected: 7 tests PASS

**Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/src/commands/doctor.test.ts
git commit -m "feat(cli): add runDoctor function with formatted output"
```

---

### Task 7: Wire doctor command into CLI

**Files:**
- Modify: `packages/cli/src/cli.ts:8` (add import)
- Modify: `packages/cli/src/cli.ts:26-32` (add to usage)
- Modify: `packages/cli/src/cli.ts:173-207` (add case to switch)

**Step 1: Add the import**

At the top of `packages/cli/src/cli.ts`, after the existing command imports (line 10), add:

```typescript
import { runDoctor } from "./commands/doctor.js";
```

**Step 2: Add to printUsage**

In the `printUsage` function, add the `doctor` command to the Commands section. After the `audit` line (line 29), add:

```typescript
"  doctor            Run system diagnostics and health checks",
```

**Step 3: Add the switch case**

In the `main()` function's switch statement, add a new case before the `help` case (before line 193):

```typescript
    case "doctor": {
      const exitCode = await runDoctor({ output: process.stdout });
      process.exit(exitCode);
      break;
    }
```

Note: `process.exit(exitCode)` is intentional — we want exit code 1 if any check fails (useful for CI scripts).

**Step 4: Run full test suite**

Run: `pnpm vitest run`
Expected: All tests pass

**Step 5: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: Clean

**Step 6: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): wire safeclaw doctor command into CLI"
```

---

### Task 8: Final verification

**Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass (existing + new doctor tests)

**Step 2: Run lint + typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: Clean

**Step 3: Verify the command works (manual)**

Run: `pnpm build && node packages/cli/dist/cli.js doctor`
Expected: Formatted report with check results grouped by category and a summary line.

Run: `node packages/cli/dist/cli.js help`
Expected: `doctor` appears in the command list.

**Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore(cli): doctor command polish"
```

---

## Reference: Complete file listing

After all tasks, the new/modified files are:

| File | Action |
|------|--------|
| `packages/cli/src/commands/doctor-types.ts` | Create |
| `packages/cli/src/commands/doctor-checks.ts` | Create |
| `packages/cli/src/commands/doctor-checks.test.ts` | Create |
| `packages/cli/src/commands/doctor.ts` | Create |
| `packages/cli/src/commands/doctor.test.ts` | Create |
| `packages/cli/src/cli.ts` | Modify (import, usage, switch case) |
| `packages/sandbox/src/index.ts` | Modify (export `findHelper`) |

## Commit history (expected)

```
feat(cli): add DiagnosticCheck and DiagnosticResult types
feat(cli): add system diagnostic checks (node, linux, arch)
feat(cli): add vault, sandbox-helper, and unshare checks
feat(cli): add kernel security checks (landlock, seccomp, namespaces)
feat(cli): add keyring, config-file, and github-connectivity checks
feat(cli): add runDoctor function with formatted output
feat(cli): wire safeclaw doctor command into CLI
```
