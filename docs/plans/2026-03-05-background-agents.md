# Long-Running Background Agents

> SafeClaw v2 — Feature 7 (depends on Feature 6: Parallel Agents)

## Problem

Some tasks take a long time (watching for test failures, monitoring file changes, continuous code review). Users want to start an agent task, have it run in the background, and check on it later — even after restarting SafeClaw.

## Design Decisions

- **Persistent**: background agent state survives restarts by serializing to disk.
- **In-process async**: same model as parallel agents — runs in the Node.js event loop.
- **Aggressive compaction**: 60% threshold instead of 80% to stay within limits during long runs.
- **Auto-pause idle**: agents with no tool calls for 30 minutes are auto-paused to save resources.
- **Shared concurrency limits**: background + sub-agents share the same max concurrent count.

## Architecture

```
~/.safeclaw/agents/
├── agent-abc123.json    # Serialized agent state
├── agent-def456.json
└── agent-ghi789.json
```

Each file contains:
```typescript
interface PersistedAgent {
  id: string;
  task: string;
  status: "running" | "paused" | "completed" | "failed";
  model: string;
  provider: string;
  sessionHistory: ChatMessage[];   // compacted
  createdAt: string;               // ISO 8601
  updatedAt: string;
  capabilities: string[];
  sharedMemory: boolean;
}
```

## Tasks

### Task 1: AgentStore

**File**: `packages/core/src/agent/agent-store.ts`

```typescript
class AgentStore {
  constructor(directory: string);  // ~/.safeclaw/agents/

  save(agent: PersistedAgent): Promise<void>;
  load(id: string): Promise<PersistedAgent | null>;
  list(): Promise<PersistedAgent[]>;
  remove(id: string): Promise<void>;
}
```

File-based JSON storage. Each agent gets its own file. File permissions 0o600 (consistent with vault).

**Test**: `packages/core/src/agent/agent-store.test.ts`
- save() creates file with correct permissions
- load() reads and parses file
- list() returns all agents
- remove() deletes file
- load() returns null for missing agent

### Task 2: Extend AgentOrchestrator with persistence

**File**: `packages/core/src/agent/orchestrator.ts`

Add to `AgentOrchestrator`:
```typescript
// Background agent methods
spawnBackground(config: SubAgentConfig): Promise<SubAgentInfo>;
pauseBackground(agentId: string): Promise<boolean>;
resumeBackground(agentId: string): Promise<boolean>;
stopBackground(agentId: string): Promise<boolean>;
listBackground(): Promise<SubAgentInfo[]>;
backgroundLog(agentId: string): Promise<string>;

// Called on startup
resumePersistedAgents(): Promise<void>;

// Called periodically (every 60s)
autoIdlePause(): void;
```

`spawnBackground()` is like `spawn()` but:
- Saves state to AgentStore after creation
- Periodically saves state during execution (every 5 minutes or after each tool call)
- Uses 60% compaction threshold
- On completion, updates persisted state

`resumePersistedAgents()`:
- Scans AgentStore for agents with status "running"
- Recreates Agent instances from persisted session history
- Resumes execution

**Test**: `packages/core/src/agent/orchestrator.test.ts` (extend existing tests)
- spawnBackground saves state to disk
- pauseBackground stops execution and persists
- resumeBackground recreates agent and continues
- resumePersistedAgents restores running agents on startup
- Auto-idle pauses agents with no activity for 30 minutes

### Task 3: Background agent slash commands

**File**: `packages/cli/src/commands/chat-commands.ts`

Add `/bg` command handler with subcommands:
- `/bg start <task>` or `/background <task>` — spawn background agent
- `/bg list` — show all background agents with status
- `/bg status <id>` — detailed status and recent output
- `/bg pause <id>` — pause a running agent
- `/bg resume <id>` — resume a paused agent
- `/bg stop <id>` — stop and remove
- `/bg log <id>` — full output history

**Test**: `packages/cli/src/commands/chat-commands.test.ts` — add /bg command tests

### Task 4: Bootstrap integration

**File**: `packages/cli/src/commands/bootstrap.ts`

- Create AgentStore with `~/.safeclaw/agents/` directory
- Pass to AgentOrchestrator
- Call `resumePersistedAgents()` during startup

### Task 5: TUI integration

**File**: `packages/tui/src/components/StatusPanel.tsx`

Show background agents in status panel with ⟳ icon and current status. They appear in the sub-agent view (Ctrl+X) alongside regular sub-agents.

### Task 6: Documentation

Update AGENTS.md, docs/architecture.md, docs/getting-started.md with background agent information.
