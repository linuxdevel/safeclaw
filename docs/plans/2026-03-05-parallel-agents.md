# Parallel Agents

> SafeClaw v2 — Feature 6 (depends on Feature 3: Context Compaction, Feature 5: TUI)

## Problem

The single-threaded sequential agent loop is slow for tasks that could be parallelized (e.g., fix 10 lint errors, research multiple files, run independent sub-tasks).

## Design Decisions

- **In-process async**: sub-agents are Promise-based, no threads or child processes. Simpler IPC, lower overhead.
- **Per-sub-agent model**: each sub-agent can use a different model via ProviderRegistry. Main agent orchestrates with a powerful model, sub-agents do fast work with cheaper models.
- **Shared memory opt-in**: key-value store shared between agents. Skills/prompts can disable sharing for isolation (e.g., prevent secret leakage).
- **Max 5 concurrent**: prevent runaway spawning.

## Architecture

```
Main Agent
  │
  ├── spawn_agent("Fix foo.ts", model: "sonnet") → Sub-Agent 1
  ├── spawn_agent("Fix bar.ts", model: "sonnet") → Sub-Agent 2
  └── spawn_agent("Research API docs")            → Sub-Agent 3
        │
        ├── All share AgentMemory (unless sharedMemory: false)
        ├── All have own Session + ContextCompactor
        └── Results reported back to Main Agent as tool results
```

## Tasks

### Task 1: AgentMemory

**File**: `packages/core/src/agent/memory.ts`

```typescript
class AgentMemory {
  set(key: string, value: unknown): void;
  get(key: string): unknown | undefined;
  keys(): string[];
  delete(key: string): boolean;
  snapshot(): Record<string, unknown>;
}
```

Thread-safe (single-threaded async, so no real concurrency issues, but use proper isolation for sub-agents with `sharedMemory: false` — they get a separate instance).

**Test**: `packages/core/src/agent/memory.test.ts`
- Basic CRUD operations
- Separate instances are isolated
- Shared instances see each other's writes

### Task 2: AgentOrchestrator

**File**: `packages/core/src/agent/orchestrator.ts`

```typescript
interface SubAgentConfig {
  task: string;
  model?: string;
  sharedMemory?: boolean;
  capabilities?: string[];
}

interface SubAgentInfo {
  id: string;
  task: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

class AgentOrchestrator {
  constructor(
    providerRegistry: ProviderRegistry,
    toolOrchestrator: ToolOrchestrator,
    capabilityRegistry: CapabilityRegistry,
    sharedMemory: AgentMemory,
    options?: { maxConcurrent?: number }
  );

  spawn(config: SubAgentConfig): Promise<SubAgentInfo>;
  status(agentId: string): SubAgentInfo | undefined;
  list(): SubAgentInfo[];
  kill(agentId: string): boolean;
  waitFor(agentId: string): Promise<SubAgentInfo>;
  shutdown(): Promise<void>;
}
```

Internally creates a new `Agent` per sub-agent with:
- Own `Session` (empty, just the task as first user message)
- Own `ContextCompactor` (auto-created by Agent, per Feature 3)
- `ModelProvider` from `ProviderRegistry` (resolved by model name)
- Shared or isolated `AgentMemory`
- Capability subset (intersection of requested caps and main agent's grants)

**Test**: `packages/core/src/agent/orchestrator.test.ts`
- Spawn creates sub-agent and returns info
- Concurrent limit enforced (6th spawn waits)
- kill() terminates running sub-agent
- waitFor() resolves when sub-agent completes
- shutdown() kills all running sub-agents

### Task 3: spawn_agent tool

**File**: `packages/core/src/tools/builtin/spawn-agent.ts`

```typescript
{
  name: "spawn_agent",
  description: "Spawn a sub-agent to work on a task concurrently",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description for the sub-agent" },
      model: { type: "string", description: "Model to use (optional)" },
      sharedMemory: { type: "boolean", description: "Share memory with main agent (default: true)" },
      capabilities: { type: "array", items: { type: "string" }, description: "Capability subset" }
    },
    required: ["task"]
  },
  requiredCapabilities: ["process:spawn"],
  execute: async (args) => { /* delegate to orchestrator.spawn() */ }
}
```

**Test**: `packages/core/src/tools/builtin/spawn-agent.test.ts`

### Task 4: agent_status tool

**File**: `packages/core/src/tools/builtin/agent-status.ts`

```typescript
{
  name: "agent_status",
  description: "Check status of a sub-agent or list all sub-agents",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "Sub-agent ID (omit to list all)" },
      action: { type: "string", enum: ["status", "list", "wait", "kill"] }
    }
  },
  requiredCapabilities: [],
  execute: async (args) => { /* delegate to orchestrator */ }
}
```

**Test**: `packages/core/src/tools/builtin/agent-status.test.ts`

### Task 5: memory tool

**File**: `packages/core/src/tools/builtin/memory.ts`

```typescript
{
  name: "memory",
  description: "Read or write shared agent memory",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["get", "set", "delete", "keys"] },
      key: { type: "string" },
      value: { type: "string" }
    },
    required: ["action"]
  },
  requiredCapabilities: [],
  execute: async (args) => { /* delegate to AgentMemory */ }
}
```

**Test**: `packages/core/src/tools/builtin/memory.test.ts`

### Task 6: Register new tools

**Files**:
- `packages/core/src/tools/builtin/index.ts` — add spawn_agent, agent_status, memory tools
- `packages/core/src/tools/index.ts` — barrel exports
- `skills/builtin/manifest.json` — add capability declarations
- `packages/core/src/tools/builtin/index.test.ts` — update tool count assertions

### Task 7: TUI sub-agent view

**File**: `packages/tui/src/components/SubAgentView.tsx`

- Tabbed interface showing sub-agent outputs
- Ctrl+X + ↓ enters view mode
- ← / → switches between sub-agent tabs
- ↑ returns to main agent view
- Chat input area hidden in sub-agent view
- Each sub-agent shows: task, status, scrollable output

### Task 8: Bootstrap integration

**File**: `packages/cli/src/commands/bootstrap.ts`

Create `AgentOrchestrator` during bootstrap, pass to agent/tools that need it.

### Task 9: Documentation

Update AGENTS.md, docs/architecture.md with orchestrator and sub-agent architecture.
