# Background Process Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `process` tool that can start background processes, poll their status, read their output, and kill them -- enabling long-running commands without blocking the agent loop.

**Architecture:** Create a `ProcessManager` singleton class that tracks spawned child processes by UUID. It stores stdout+stderr in a per-process ring buffer (max 1MB) and auto-cleans finished processes after 1 hour. A new `process` tool with subcommands (`start`, `status`, `log`, `kill`, `list`) delegates to `ProcessManager` methods. Existing `bash` tool remains unchanged for quick synchronous commands. Processes inherit sandbox restrictions because they're spawned inside the same process tree.

**Tech Stack:** TypeScript, Node.js `child_process` (spawn), `crypto.randomUUID()`, Vitest

---

### Task 1: Create `ProcessManager` class -- types and constructor

**Files:**
- Create: `packages/core/src/tools/process-manager.ts`
- Test: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/tools/process-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessManager } from "./process-manager.js";

describe("ProcessManager", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
  });

  afterEach(() => {
    pm.shutdown();
  });

  it("can be instantiated", () => {
    expect(pm).toBeInstanceOf(ProcessManager);
  });

  it("list() returns empty array initially", () => {
    expect(pm.list()).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: FAIL -- module `./process-manager.js` not found.

**Step 3: Write minimal implementation**

Create `packages/core/src/tools/process-manager.ts`:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface ProcessStatus {
  id: string;
  pid: number | undefined;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  duration: number;
}

interface TrackedProcess {
  id: string;
  child: ChildProcess;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  output: string[];
  outputBytes: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB per process
const MAX_CONCURRENT = 8;
const CLEANUP_INTERVAL_MS = 60_000; // Check every minute
const CLEANUP_AGE_MS = 3_600_000; // Remove finished processes after 1 hour

export class ProcessManager {
  private readonly processes = new Map<string, TrackedProcess>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow Node to exit even if timer is running
    this.cleanupTimer.unref();
  }

  list(): ProcessStatus[] {
    return [...this.processes.values()].map((p) => this.toStatus(p));
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const tracked of this.processes.values()) {
      if (tracked.running) {
        tracked.child.kill("SIGKILL");
      }
    }
    this.processes.clear();
  }

  private toStatus(tracked: TrackedProcess): ProcessStatus {
    const now = Date.now();
    return {
      id: tracked.id,
      pid: tracked.child.pid,
      running: tracked.running,
      exitCode: tracked.exitCode,
      startedAt: tracked.startedAt,
      duration: (tracked.finishedAt ?? now) - tracked.startedAt,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, tracked] of this.processes) {
      if (!tracked.running && tracked.finishedAt !== null) {
        if (now - tracked.finishedAt > CLEANUP_AGE_MS) {
          this.processes.delete(id);
        }
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/core/src/tools/process-manager.ts packages/core/src/tools/process-manager.test.ts
git commit -m "feat(tools): add ProcessManager skeleton with types and cleanup"
```

---

### Task 2: Implement `ProcessManager.start()`

**Files:**
- Modify: `packages/core/src/tools/process-manager.ts`
- Modify: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the failing test**

Add to the `describe("ProcessManager")` block in `process-manager.test.ts`:

```typescript
  it("start() spawns a process and returns an id", () => {
    const id = pm.start("echo hello");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(pm.list()).toHaveLength(1);
  });

  it("start() rejects empty command", () => {
    expect(() => pm.start("")).toThrow(/command/i);
  });

  it("start() enforces max concurrent process limit", () => {
    for (let i = 0; i < 8; i++) {
      pm.start(`sleep ${i + 10}`);
    }
    expect(() => pm.start("sleep 20")).toThrow(/concurrent/i);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: FAIL -- `pm.start` is not a function.

**Step 3: Write minimal implementation**

Add the `start` method to `ProcessManager` in `process-manager.ts`, before `shutdown()`:

```typescript
  start(command: string, options?: { cwd?: string }): string {
    if (!command || typeof command !== "string") {
      throw new Error("Required argument 'command' must be a non-empty string");
    }

    const runningCount = [...this.processes.values()].filter(
      (p) => p.running,
    ).length;
    if (runningCount >= MAX_CONCURRENT) {
      throw new Error(
        `Max concurrent process limit reached (${MAX_CONCURRENT})`,
      );
    }

    const id = randomUUID();
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tracked: TrackedProcess = {
      id,
      child,
      running: true,
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      output: [],
      outputBytes: 0,
    };

    const appendOutput = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      tracked.output.push(text);
      tracked.outputBytes += text.length;

      // Evict oldest entries if over budget
      while (tracked.outputBytes > MAX_OUTPUT_BYTES && tracked.output.length > 1) {
        const removed = tracked.output.shift()!;
        tracked.outputBytes -= removed.length;
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.on("close", (code: number | null) => {
      tracked.running = false;
      tracked.exitCode = code;
      tracked.finishedAt = Date.now();
    });

    this.processes.set(id, tracked);
    return id;
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add packages/core/src/tools/process-manager.ts packages/core/src/tools/process-manager.test.ts
git commit -m "feat(tools): implement ProcessManager.start() with concurrency limit"
```

---

### Task 3: Implement `ProcessManager.status()`

**Files:**
- Modify: `packages/core/src/tools/process-manager.ts`
- Modify: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the failing test**

Add to the `describe("ProcessManager")` block:

```typescript
  it("status() returns status of a running process", () => {
    const id = pm.start("sleep 30");
    const status = pm.status(id);
    expect(status.id).toBe(id);
    expect(status.running).toBe(true);
    expect(status.exitCode).toBeNull();
    expect(status.startedAt).toBeGreaterThan(0);
    expect(status.duration).toBeGreaterThanOrEqual(0);
    expect(typeof status.pid).toBe("number");
  });

  it("status() returns status of a finished process", async () => {
    const id = pm.start("echo done");
    // Wait for process to finish
    await new Promise((r) => setTimeout(r, 200));
    const status = pm.status(id);
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
  });

  it("status() throws for unknown id", () => {
    expect(() => pm.status("nonexistent")).toThrow(/not found/i);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: FAIL -- `pm.status` is not a function.

**Step 3: Write minimal implementation**

Add to `ProcessManager`, before `shutdown()`:

```typescript
  status(id: string): ProcessStatus {
    const tracked = this.processes.get(id);
    if (!tracked) {
      throw new Error(`Process not found: "${id}"`);
    }
    return this.toStatus(tracked);
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (8 tests).

**Step 5: Commit**

```bash
git add packages/core/src/tools/process-manager.ts packages/core/src/tools/process-manager.test.ts
git commit -m "feat(tools): implement ProcessManager.status()"
```

---

### Task 4: Implement `ProcessManager.log()`

**Files:**
- Modify: `packages/core/src/tools/process-manager.ts`
- Modify: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the failing test**

Add to the `describe("ProcessManager")` block:

```typescript
  it("log() returns captured output", async () => {
    const id = pm.start("echo hello && echo world");
    await new Promise((r) => setTimeout(r, 200));
    const output = pm.log(id);
    expect(output).toContain("hello");
    expect(output).toContain("world");
  });

  it("log() returns tail lines when specified", async () => {
    const id = pm.start("for i in 1 2 3 4 5; do echo line$i; done");
    await new Promise((r) => setTimeout(r, 200));
    const output = pm.log(id, { tail: 2 });
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("line4");
    expect(lines[1]).toBe("line5");
  });

  it("log() throws for unknown id", () => {
    expect(() => pm.log("nonexistent")).toThrow(/not found/i);
  });

  it("log() returns empty string when no output yet", () => {
    const id = pm.start("sleep 30");
    const output = pm.log(id);
    expect(output).toBe("");
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: FAIL -- `pm.log` is not a function.

**Step 3: Write minimal implementation**

Add to `ProcessManager`, after `status()`:

```typescript
  log(id: string, options?: { tail?: number }): string {
    const tracked = this.processes.get(id);
    if (!tracked) {
      throw new Error(`Process not found: "${id}"`);
    }

    const fullOutput = tracked.output.join("");
    if (!fullOutput) return "";

    if (options?.tail !== undefined && options.tail > 0) {
      const lines = fullOutput.trimEnd().split("\n");
      return lines.slice(-options.tail).join("\n") + "\n";
    }

    return fullOutput;
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (12 tests).

**Step 5: Commit**

```bash
git add packages/core/src/tools/process-manager.ts packages/core/src/tools/process-manager.test.ts
git commit -m "feat(tools): implement ProcessManager.log() with tail support"
```

---

### Task 5: Implement `ProcessManager.kill()`

**Files:**
- Modify: `packages/core/src/tools/process-manager.ts`
- Modify: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the failing test**

Add to the `describe("ProcessManager")` block:

```typescript
  it("kill() terminates a running process", async () => {
    const id = pm.start("sleep 60");
    await new Promise((r) => setTimeout(r, 100));
    const killed = pm.kill(id);
    expect(killed).toBe(true);
    // Wait for process to actually exit
    await new Promise((r) => setTimeout(r, 200));
    const status = pm.status(id);
    expect(status.running).toBe(false);
  });

  it("kill() returns false for already-finished process", async () => {
    const id = pm.start("echo quick");
    await new Promise((r) => setTimeout(r, 200));
    const killed = pm.kill(id);
    expect(killed).toBe(false);
  });

  it("kill() throws for unknown id", () => {
    expect(() => pm.kill("nonexistent")).toThrow(/not found/i);
  });

  it("kill() accepts a custom signal", async () => {
    const id = pm.start("sleep 60");
    await new Promise((r) => setTimeout(r, 100));
    const killed = pm.kill(id, "SIGKILL");
    expect(killed).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.status(id).running).toBe(false);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: FAIL -- `pm.kill` is not a function.

**Step 3: Write minimal implementation**

Add to `ProcessManager`, after `log()`:

```typescript
  kill(id: string, signal?: string): boolean {
    const tracked = this.processes.get(id);
    if (!tracked) {
      throw new Error(`Process not found: "${id}"`);
    }
    if (!tracked.running) {
      return false;
    }
    return tracked.child.kill((signal as NodeJS.Signals) ?? "SIGTERM");
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (16 tests).

**Step 5: Commit**

```bash
git add packages/core/src/tools/process-manager.ts packages/core/src/tools/process-manager.test.ts
git commit -m "feat(tools): implement ProcessManager.kill() with signal support"
```

---

### Task 6: Test ring buffer eviction in `ProcessManager`

**Files:**
- Modify: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the test**

Add to the `describe("ProcessManager")` block:

```typescript
  it("evicts oldest output when ring buffer exceeds 1MB", async () => {
    // Generate output that exceeds 1MB
    // Each iteration of seq prints ~7 bytes ("NNNNN\n"), 200000 iterations ~ 1.4MB
    const id = pm.start("seq 1 200000");
    // Wait for command to finish
    await new Promise((r) => setTimeout(r, 3000));
    const output = pm.log(id);
    // Output should be truncated to ~1MB
    const outputBytes = Buffer.byteLength(output, "utf-8");
    expect(outputBytes).toBeLessThanOrEqual(1024 * 1024 + 65536); // Allow some slack for last chunk
    // Should still contain recent lines (end of sequence)
    expect(output).toContain("200000");
    // Should NOT contain early lines (evicted)
    expect(output).not.toContain("\n1\n");
  });
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (17 tests). This test validates existing ring buffer logic from Task 2.

**Step 3: Commit**

```bash
git add packages/core/src/tools/process-manager.test.ts
git commit -m "test(tools): verify ring buffer eviction in ProcessManager"
```

---

### Task 7: Test auto-cleanup of finished processes

**Files:**
- Modify: `packages/core/src/tools/process-manager.test.ts`

**Step 1: Write the test**

Add to the `describe("ProcessManager")` block:

```typescript
  it("cleanup removes finished processes older than threshold", async () => {
    const id = pm.start("echo done");
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.status(id).running).toBe(false);

    // Manually access internals to age the process
    // We use type assertion since cleanup is private -- this is a white-box test
    const internals = pm as unknown as {
      processes: Map<string, { finishedAt: number | null }>;
      cleanup: () => void;
    };
    const tracked = internals.processes.get(id)!;
    tracked.finishedAt = Date.now() - 3_600_001; // Just over 1 hour ago

    internals.cleanup();

    expect(pm.list()).toHaveLength(0);
    expect(() => pm.status(id)).toThrow(/not found/i);
  });

  it("cleanup does not remove still-running processes", async () => {
    const id = pm.start("sleep 60");
    await new Promise((r) => setTimeout(r, 100));

    const internals = pm as unknown as { cleanup: () => void };
    internals.cleanup();

    expect(pm.list()).toHaveLength(1);
    expect(pm.status(id).running).toBe(true);
  });
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/process-manager.test.ts`

Expected: PASS (19 tests). These tests exercise the existing cleanup logic from Task 1.

**Step 3: Commit**

```bash
git add packages/core/src/tools/process-manager.test.ts
git commit -m "test(tools): verify ProcessManager auto-cleanup behavior"
```

---

### Task 8: Create `process` tool -- argument validation

**Files:**
- Create: `packages/core/src/tools/builtin/process.ts`
- Create: `packages/core/src/tools/builtin/process.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/tools/builtin/process.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createProcessTool } from "./process.js";
import { ProcessManager } from "../process-manager.js";

describe("processTool", () => {
  let pm: ProcessManager;

  afterEach(() => {
    pm?.shutdown();
  });

  function setup() {
    pm = new ProcessManager();
    return createProcessTool(pm);
  }

  it("has correct name and metadata", () => {
    const tool = setup();
    expect(tool.name).toBe("process");
    expect(tool.description).toBeTruthy();
    expect(tool.requiredCapabilities).toEqual(["process:spawn"]);
  });

  it("rejects missing action argument", async () => {
    const tool = setup();
    await expect(tool.execute({})).rejects.toThrow(/action/i);
  });

  it("rejects unknown action", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "explode" })).rejects.toThrow(
      /unknown action/i,
    );
  });

  it("start rejects missing command", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "start" })).rejects.toThrow(
      /command/i,
    );
  });

  it("status rejects missing processId", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "status" })).rejects.toThrow(
      /processId/i,
    );
  });

  it("log rejects missing processId", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "log" })).rejects.toThrow(
      /processId/i,
    );
  });

  it("kill rejects missing processId", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "kill" })).rejects.toThrow(
      /processId/i,
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/process.test.ts`

Expected: FAIL -- module `./process.js` not found.

**Step 3: Write minimal implementation**

Create `packages/core/src/tools/builtin/process.ts`:

```typescript
import type { ToolHandler } from "../types.js";
import type { ProcessManager } from "../process-manager.js";

type Action = "start" | "status" | "log" | "kill" | "list";
const VALID_ACTIONS: Action[] = ["start", "status", "log", "kill", "list"];

export function createProcessTool(processManager: ProcessManager): ToolHandler {
  return {
    name: "process",
    description:
      "Manage background processes: start, check status, read output, kill, or list all",
    requiredCapabilities: ["process:spawn"],

    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args["action"];
      if (typeof action !== "string") {
        throw new Error("Required argument 'action' must be a string");
      }

      if (!VALID_ACTIONS.includes(action as Action)) {
        throw new Error(
          `Unknown action "${action}". Must be one of: ${VALID_ACTIONS.join(", ")}`,
        );
      }

      switch (action as Action) {
        case "start":
          return handleStart(processManager, args);
        case "status":
          return handleStatus(processManager, args);
        case "log":
          return handleLog(processManager, args);
        case "kill":
          return handleKill(processManager, args);
        case "list":
          return handleList(processManager);
      }
    },
  };
}

function requireProcessId(args: Record<string, unknown>): string {
  const processId = args["processId"];
  if (typeof processId !== "string" || !processId) {
    throw new Error("Required argument 'processId' must be a non-empty string");
  }
  return processId;
}

function handleStart(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const command = args["command"];
  if (typeof command !== "string" || !command) {
    throw new Error("Required argument 'command' must be a non-empty string");
  }
  const cwd =
    args["cwd"] !== undefined ? String(args["cwd"]) : undefined;
  const id = pm.start(command, { cwd });
  const status = pm.status(id);
  return JSON.stringify(status);
}

function handleStatus(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const id = requireProcessId(args);
  return JSON.stringify(pm.status(id));
}

function handleLog(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const id = requireProcessId(args);
  const tail =
    args["tail"] !== undefined ? Number(args["tail"]) : undefined;
  return pm.log(id, tail !== undefined ? { tail } : undefined);
}

function handleKill(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const id = requireProcessId(args);
  const signal =
    args["signal"] !== undefined ? String(args["signal"]) : undefined;
  const killed = pm.kill(id, signal);
  return JSON.stringify({ id, killed });
}

function handleList(pm: ProcessManager): string {
  return JSON.stringify(pm.list());
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/process.test.ts`

Expected: PASS (7 tests).

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/process.ts packages/core/src/tools/builtin/process.test.ts
git commit -m "feat(tools): add process tool with argument validation"
```

---

### Task 9: Test `process` tool -- action dispatch integration

**Files:**
- Modify: `packages/core/src/tools/builtin/process.test.ts`

**Step 1: Write the tests**

Add to the `describe("processTool")` block in `process.test.ts`:

```typescript
  it("start action spawns a process and returns status JSON", async () => {
    const tool = setup();
    const result = await tool.execute({ action: "start", command: "sleep 30" });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBeTruthy();
    expect(parsed.running).toBe(true);
    expect(typeof parsed.pid).toBe("number");
  });

  it("status action returns process status", async () => {
    const tool = setup();
    const startResult = JSON.parse(
      await tool.execute({ action: "start", command: "sleep 30" }),
    );
    const statusResult = JSON.parse(
      await tool.execute({ action: "status", processId: startResult.id }),
    );
    expect(statusResult.id).toBe(startResult.id);
    expect(statusResult.running).toBe(true);
  });

  it("log action returns process output", async () => {
    const tool = setup();
    const startResult = JSON.parse(
      await tool.execute({ action: "start", command: "echo test-output" }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const output = await tool.execute({
      action: "log",
      processId: startResult.id,
    });
    expect(output).toContain("test-output");
  });

  it("kill action terminates a running process", async () => {
    const tool = setup();
    const startResult = JSON.parse(
      await tool.execute({ action: "start", command: "sleep 60" }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const killResult = JSON.parse(
      await tool.execute({ action: "kill", processId: startResult.id }),
    );
    expect(killResult.killed).toBe(true);
  });

  it("list action returns all processes", async () => {
    const tool = setup();
    await tool.execute({ action: "start", command: "sleep 30" });
    await tool.execute({ action: "start", command: "sleep 31" });
    const listResult = JSON.parse(await tool.execute({ action: "list" }));
    expect(listResult).toHaveLength(2);
  });

  it("start action passes cwd option", async () => {
    const tool = setup();
    const result = await tool.execute({
      action: "start",
      command: "pwd",
      cwd: "/tmp",
    });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBeTruthy();
    // Verify cwd was used by reading output
    await new Promise((r) => setTimeout(r, 200));
    const output = await tool.execute({
      action: "log",
      processId: parsed.id,
    });
    expect(output.trim()).toBe("/tmp");
  });
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/process.test.ts`

Expected: PASS (13 tests). These exercise the integration between the tool and ProcessManager.

**Step 3: Commit**

```bash
git add packages/core/src/tools/builtin/process.test.ts
git commit -m "test(tools): add process tool action dispatch integration tests"
```

---

### Task 10: Register process tool in `createBuiltinTools()`

**Files:**
- Modify: `packages/core/src/tools/builtin/index.ts:1-13`
- Modify: `packages/core/src/tools/index.ts:9-16`

**Step 1: Update `createBuiltinTools()` to accept a `ProcessManager`**

The `process` tool requires a `ProcessManager` instance, so `createBuiltinTools()` must accept one. Modify `packages/core/src/tools/builtin/index.ts`:

```typescript
import type { ToolHandler } from "../types.js";
import type { ProcessManager } from "../process-manager.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { webFetchTool } from "./web-fetch.js";
import { createProcessTool } from "./process.js";

export { readTool, writeTool, editTool, bashTool, webFetchTool, createProcessTool };

/** Creates an array of all built-in tool handlers. */
export function createBuiltinTools(processManager?: ProcessManager): ToolHandler[] {
  const tools: ToolHandler[] = [readTool, writeTool, editTool, bashTool, webFetchTool];
  if (processManager) {
    tools.push(createProcessTool(processManager));
  }
  return tools;
}
```

**Step 2: Update barrel exports**

In `packages/core/src/tools/index.ts`, add `ProcessManager` and `createProcessTool` exports. Replace the existing content:

```typescript
export { ToolOrchestrator, SimpleToolRegistry } from "./orchestrator.js";
export type { OrchestratorOptions } from "./orchestrator.js";
export type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolHandler,
  ToolRegistry,
} from "./types.js";
export {
  createBuiltinTools,
  readTool,
  writeTool,
  editTool,
  bashTool,
  webFetchTool,
  createProcessTool,
} from "./builtin/index.js";
export { ProcessManager } from "./process-manager.js";
export type { ProcessStatus } from "./process-manager.js";
export { AuditLog } from "./audit-log.js";
export type { AuditEntry } from "./audit-log.js";
```

**Step 3: Verify everything compiles**

Run: `npx tsc --build --dry 2>&1 | head -20`

Expected: No errors. The `processManager` parameter is optional, so existing callers of `createBuiltinTools()` (with no arguments) continue to work without changes.

**Step 4: Run full test suite**

Run: `npx vitest run`

Expected: All tests pass, including existing ones. No regressions.

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/index.ts packages/core/src/tools/index.ts
git commit -m "feat(tools): register process tool in createBuiltinTools()"
```

---

### Task 11: Lint check and final verification

**Files:** None (verification only).

**Step 1: Run linter**

Run: `pnpm lint`

Expected: No new lint errors introduced by our changes.

**Step 2: Run full test suite**

Run: `pnpm test`

Expected: All tests pass.

**Step 3: Run type checker**

Run: `pnpm typecheck`

Expected: No type errors.

**Step 4: Commit any lint/type fixes if needed**

If any issues were found, fix them and commit:

```bash
git add -A
git commit -m "fix(tools): resolve lint/type issues in process management"
```

---

## Files Created/Modified Summary

| File | Action |
|------|--------|
| `packages/core/src/tools/process-manager.ts` | Create |
| `packages/core/src/tools/process-manager.test.ts` | Create |
| `packages/core/src/tools/builtin/process.ts` | Create |
| `packages/core/src/tools/builtin/process.test.ts` | Create |
| `packages/core/src/tools/builtin/index.ts` | Modify |
| `packages/core/src/tools/index.ts` | Modify |

## Security Considerations

- Processes inherit the OS-level sandbox restrictions (Landlock, seccomp-BPF, namespaces) because they are spawned as child processes within the same sandbox boundary.
- Max concurrent process limit (8) prevents fork-bomb-style resource exhaustion.
- Ring buffer cap (1MB) prevents memory exhaustion from verbose processes.
- Auto-cleanup after 1 hour prevents stale process accumulation.
- The `process` tool requires `process:spawn` capability, enforced by `CapabilityEnforcer` before execution.
- `stdin` is set to `"ignore"` -- background processes cannot read interactive input.
