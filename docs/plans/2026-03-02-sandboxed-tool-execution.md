# Sandbox-Enforced Tool Execution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route tool executions through `Sandbox.execute()` so built-in tools (bash, read, write, edit, web_fetch) run inside the OS-level sandbox instead of directly on the host.

**Architecture:** Currently `ToolOrchestrator.execute()` calls `handler.execute(args)` directly (line 67 of `orchestrator.ts`) and always reports `sandboxed: false`. The fix introduces a `SandboxedToolOrchestrator` that wraps the existing orchestrator and routes eligible tool executions through `Sandbox.execute()`. Not all tools can be sandboxed the same way — `bash` spawns a subprocess (natural sandbox target), while `read`/`write`/`edit` use Node.js filesystem APIs (would need the helper process). The approach:

- **Phase 1 (this plan):** Sandbox the `bash` tool — it spawns `/bin/bash -c <command>`, which maps directly to `Sandbox.execute("/bin/bash", ["-c", command])`.
- **Phase 2 (future):** Sandbox `read`/`write`/`edit`/`web_fetch` by running them through a sandboxed Node.js subprocess.

The `ToolOrchestrator` gains an optional `Sandbox` dependency. When present and the tool is sandbox-eligible, execution goes through `Sandbox.execute()` instead of direct `handler.execute()`.

**Tech Stack:** TypeScript, vitest, @safeclaw/sandbox (Sandbox), @safeclaw/core (ToolOrchestrator)

**Prerequisites:** Sandbox execution plan must be implemented first (`Sandbox.execute()` must work).

---

### Task 1: Add Sandbox dependency to ToolOrchestrator

**Files:**
- Modify: `packages/core/src/tools/orchestrator.ts`
- Test: `packages/core/src/tools/orchestrator.test.ts`

**Step 1: Write the failing test**

Add to `orchestrator.test.ts`:

```typescript
describe("sandboxed execution", () => {
  it("reports sandboxed: true when sandbox is provided and tool is eligible", async () => {
    const registry = new SimpleToolRegistry();
    registry.register(bashToolHandler); // a mock bash handler

    const capRegistry = new CapabilityRegistry();
    capRegistry.grantCapability({
      skillId: "test",
      capability: "process:spawn",
      grantedAt: new Date(),
      grantedBy: "user",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const mockSandbox = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "sandboxed output",
        stderr: "",
        durationMs: 5,
        killed: false,
      }),
      getPolicy: vi.fn(),
    };

    const orchestrator = new ToolOrchestrator(enforcer, registry, {
      sandbox: mockSandbox,
      sandboxedTools: ["bash"],
    });

    const result = await orchestrator.execute({
      skillId: "test",
      toolName: "bash",
      args: { command: "echo hello" },
    });

    expect(result.sandboxed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.output).toBe("sandboxed output");
    expect(mockSandbox.execute).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", "echo hello"],
    );
  });

  it("falls back to direct execution when no sandbox provided", async () => {
    // existing behavior unchanged
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/tools/orchestrator.test.ts`
Expected: FAIL — ToolOrchestrator constructor doesn't accept sandbox options

**Step 3: Implement sandbox support in ToolOrchestrator**

```typescript
import type { Sandbox } from "@safeclaw/sandbox";

interface SandboxOptions {
  sandbox: Pick<Sandbox, "execute">;
  sandboxedTools: string[];
}

export class ToolOrchestrator {
  constructor(
    private readonly enforcer: CapabilityEnforcer,
    private readonly toolRegistry: ToolRegistry,
    private readonly sandboxOptions?: SandboxOptions,
  ) {}

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const start = performance.now();

    // 1. Look up tool handler
    const handler = this.toolRegistry.get(request.toolName);
    if (!handler) {
      return {
        success: false,
        output: "",
        error: `Tool not found: "${request.toolName}"`,
        durationMs: performance.now() - start,
        sandboxed: false,
      };
    }

    // 2. Check capabilities (unchanged)
    for (const capability of handler.requiredCapabilities) {
      try {
        this.enforcer.check(request.skillId, capability);
      } catch (err: unknown) {
        return {
          success: false,
          output: "",
          error:
            err instanceof CapabilityDeniedError
              ? err.message
              : `Capability check failed: ${String(err)}`,
          durationMs: performance.now() - start,
          sandboxed: false,
        };
      }
    }

    // 3. Execute — sandboxed if eligible, direct otherwise
    const shouldSandbox =
      this.sandboxOptions &&
      this.sandboxOptions.sandboxedTools.includes(request.toolName);

    if (shouldSandbox) {
      return this.executeSandboxed(request, start);
    }

    return this.executeDirect(handler, request, start);
  }

  private async executeSandboxed(
    request: ToolExecutionRequest,
    start: number,
  ): Promise<ToolExecutionResult> {
    try {
      const { command, args } = this.buildSandboxCommand(
        request.toolName,
        request.args,
      );
      const result = await this.sandboxOptions!.sandbox.execute(command, args);

      return {
        success: result.exitCode === 0,
        output: result.stdout,
        error: result.exitCode !== 0 ? result.stderr || `Exit code: ${result.exitCode}` : undefined,
        durationMs: performance.now() - start,
        sandboxed: true,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - start,
        sandboxed: true,
      };
    }
  }

  private async executeDirect(
    handler: ToolHandler,
    request: ToolExecutionRequest,
    start: number,
  ): Promise<ToolExecutionResult> {
    try {
      const output = await handler.execute(request.args);
      return {
        success: true,
        output,
        durationMs: performance.now() - start,
        sandboxed: false,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : `Tool execution failed: ${String(err)}`,
        durationMs: performance.now() - start,
        sandboxed: false,
      };
    }
  }

  private buildSandboxCommand(
    toolName: string,
    args: Record<string, unknown>,
  ): { command: string; args: string[] } {
    switch (toolName) {
      case "bash":
        return {
          command: "/bin/bash",
          args: ["-c", String(args["command"] ?? "")],
        };
      default:
        throw new Error(`No sandbox command mapping for tool: ${toolName}`);
    }
  }
}
```

**Step 4: Run tests**

Run: `pnpm vitest run packages/core/src/tools/orchestrator.test.ts`
Expected: All PASS

**Step 5: Commit**

```
feat(core): add sandbox support to ToolOrchestrator
```

---

### Task 2: Wire Sandbox into bootstrap

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts`

**Step 1: Import and construct Sandbox**

After the `Sandbox.execute()` implementation is done, add sandbox construction to bootstrap:

```typescript
import { Sandbox, DEFAULT_POLICY } from "@safeclaw/sandbox";

// In bootstrapAgent(), after building the tool registry:
let sandbox: Sandbox | undefined;
try {
  sandbox = new Sandbox(DEFAULT_POLICY);
} catch {
  // Sandbox not supported on this system — fall back to unsandboxed
  output.write(
    "Warning: sandbox not available, tools will run unsandboxed\n",
  );
}

const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, sandbox
  ? { sandbox, sandboxedTools: ["bash"] }
  : undefined,
);
```

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All pass. Bootstrap tests mock the sandbox detection, so they won't actually create a sandbox.

**Step 3: Commit**

```
feat(cli): wire Sandbox into bootstrap for sandboxed bash execution
```

---

### Task 3: Record sandboxed status in audit log

**Files:**
- Modify: `packages/core/src/tools/orchestrator.ts` (add audit log recording)
- Test: `packages/core/src/tools/orchestrator.test.ts`

**Step 1: Write the failing test**

```typescript
it("records sandboxed execution in audit log", async () => {
  const auditLog = new AuditLog();
  const orchestrator = new ToolOrchestrator(enforcer, registry, {
    sandbox: mockSandbox,
    sandboxedTools: ["bash"],
    auditLog,
  });

  await orchestrator.execute({
    skillId: "test",
    toolName: "bash",
    args: { command: "echo test" },
  });

  const entries = auditLog.getEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.result.sandboxed).toBe(true);
});
```

**Step 2: Add optional auditLog to SandboxOptions**

```typescript
interface OrchestratorOptions {
  sandbox?: Pick<Sandbox, "execute">;
  sandboxedTools?: string[];
  auditLog?: AuditLog;
}
```

After each execution, if `auditLog` is provided, call `auditLog.record(request, result)`.

**Step 3: Run tests and commit**

```
feat(core): record tool executions in audit log via orchestrator
```

---

## Implementation Order and Dependencies

```
sandbox-execution plan (Sandbox.execute() works)
       │
       ▼
Task 1: Add sandbox support to ToolOrchestrator
       │
       ▼
Task 2: Wire Sandbox into bootstrap
       │
       ▼
Task 3: Record in audit log
```

This plan depends on the sandbox-execution plan being completed first. Without a working `Sandbox.execute()`, the sandbox option in ToolOrchestrator will have nothing to delegate to.

## Phase 2 (Future)

For `read`, `write`, `edit`, and `web_fetch` tools, sandboxing requires running a Node.js subprocess inside the sandbox:

```
Sandbox.execute("node", ["--eval", "<tool-runner-script>"])
```

The tool runner script would receive the tool arguments via stdin (JSON), execute the tool logic, and write the result to stdout. This is a separate plan because it requires:
- A tool runner entry point
- Serialization/deserialization of tool args and results
- Proper Node.js binary path detection inside the sandbox
