# Chat Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `/new`, `/status`, `/compact`, `/model`, and `/help` slash commands to the CLI chat interface so users can manage sessions, inspect state, and switch models without leaving the REPL.

**Architecture:** Create a `ChatCommandHandler` class in `packages/cli/src/commands/chat-commands.ts` that owns all command parsing and execution. The handler takes session, agent, and output references via constructor injection. In `setupChat()`, intercept lines starting with `/` before forwarding to the agent -- if the input is a command, execute it locally and return the result; otherwise, pass through to the agent as before.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Create ChatCommandHandler with `/help` command

**Files:**
- Create: `packages/cli/src/commands/chat-commands.ts`
- Test: `packages/cli/src/commands/chat-commands.test.ts`

### Step 1: Write the failing test

Create `packages/cli/src/commands/chat-commands.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ChatCommandHandler } from "./chat-commands.js";
import type { Agent, Session, SessionManager } from "@safeclaw/core";

function makeDeps(overrides: Partial<{
  session: Session;
  sessionManager: SessionManager;
  agent: Agent;
}> = {}) {
  const session = overrides.session ?? {
    id: "test-id",
    metadata: {
      id: "test-id",
      peer: { channelId: "cli", peerId: "local" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:01:00Z"),
      messageCount: 5,
    },
    clearHistory: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  } as unknown as Session;

  const sessionManager = overrides.sessionManager ?? {
    activeCount: 1,
    listSessions: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager;

  const agent = overrides.agent ?? {
    processMessage: vi.fn().mockResolvedValue({
      message: "ok",
      toolCallsMade: 0,
      model: "claude-sonnet-4",
    }),
  } as unknown as Agent;

  return { session, sessionManager, agent };
}

describe("ChatCommandHandler", () => {
  describe("isCommand", () => {
    it("returns true for strings starting with /", () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      expect(handler.isCommand("/help")).toBe(true);
      expect(handler.isCommand("/new")).toBe(true);
    });

    it("returns false for regular messages", () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      expect(handler.isCommand("hello")).toBe(false);
      expect(handler.isCommand("")).toBe(false);
      expect(handler.isCommand("what is /help?")).toBe(false);
    });
  });

  describe("/help", () => {
    it("lists all available commands", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/help");
      expect(result).toContain("/new");
      expect(result).toContain("/status");
      expect(result).toContain("/compact");
      expect(result).toContain("/model");
      expect(result).toContain("/help");
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: FAIL — module `./chat-commands.js` not found

### Step 3: Write minimal implementation

Create `packages/cli/src/commands/chat-commands.ts`:

```typescript
import type { Agent, Session, SessionManager } from "@safeclaw/core";

export interface ChatCommandDeps {
  session: Session;
  sessionManager: SessionManager;
  agent: Agent;
}

export class ChatCommandHandler {
  private readonly session: Session;
  private readonly sessionManager: SessionManager;
  private readonly agent: Agent;

  constructor(deps: ChatCommandDeps) {
    this.session = deps.session;
    this.sessionManager = deps.sessionManager;
    this.agent = deps.agent;
  }

  isCommand(input: string): boolean {
    return input.startsWith("/");
  }

  async execute(input: string): Promise<string> {
    const parts = input.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";
    const args = parts.slice(1);

    switch (command) {
      case "help":
        return this.helpCommand();
      default:
        return `Unknown command: /${command}. Type /help for available commands.`;
    }
  }

  private helpCommand(): string {
    const lines = [
      "Available commands:",
      "  /new      Clear session history and start fresh",
      "  /status   Show session metadata and current model",
      "  /compact  Compact conversation context (placeholder)",
      "  /model    Show or change the current model",
      "  /help     Show this help message",
    ];
    return lines.join("\n");
  }
}
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: PASS — 3 tests pass

### Step 5: Commit

```bash
git add packages/cli/src/commands/chat-commands.ts packages/cli/src/commands/chat-commands.test.ts
git commit -m "feat(cli): add ChatCommandHandler with /help command"
```

---

## Task 2: Add `/new` command

**Files:**
- Modify: `packages/cli/src/commands/chat-commands.ts:30-35` (add case to switch)
- Modify: `packages/cli/src/commands/chat-commands.test.ts` (add tests)

### Step 1: Write the failing test

Append to the `describe("ChatCommandHandler")` block in `chat-commands.test.ts`:

```typescript
  describe("/new", () => {
    it("clears session history", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      await handler.execute("/new");
      expect(deps.session.clearHistory).toHaveBeenCalled();
    });

    it("returns confirmation message", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/new");
      expect(result).toContain("Session cleared");
    });
  });
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: FAIL — "Unknown command" does not contain "Session cleared"

### Step 3: Write minimal implementation

In `chat-commands.ts`, add a case to the switch in `execute()` and a private method:

```typescript
// In execute() switch, before default:
      case "new":
        return this.newCommand();
```

```typescript
// New private method:
  private newCommand(): string {
    this.session.clearHistory();
    return "Session cleared. Starting fresh.";
  }
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: PASS — 5 tests pass

### Step 5: Commit

```bash
git add packages/cli/src/commands/chat-commands.ts packages/cli/src/commands/chat-commands.test.ts
git commit -m "feat(cli): add /new command to clear session history"
```

---

## Task 3: Add `/status` command

**Files:**
- Modify: `packages/cli/src/commands/chat-commands.ts:30-35` (add case to switch)
- Modify: `packages/cli/src/commands/chat-commands.test.ts` (add tests)

**Context:** `session.metadata` returns `{ id, peer, createdAt, updatedAt, messageCount }`. The Agent class has `private readonly config: AgentConfig` with no public getter for `model`. We need to pass the current model name into `ChatCommandDeps` rather than reaching into the agent.

### Step 1: Write the failing test

Append to the `describe("ChatCommandHandler")` block in `chat-commands.test.ts`:

```typescript
  describe("/status", () => {
    it("shows session id and message count", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/status");
      expect(result).toContain("test-id");
      expect(result).toContain("5");
    });

    it("shows the current model", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/status");
      expect(result).toContain("claude-sonnet-4");
    });

    it("shows created and updated timestamps", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/status");
      expect(result).toContain("2026-01-01");
    });
  });
```

But wait — the handler needs to know the current model. Update `makeDeps()` and `ChatCommandDeps` first. Modify the `makeDeps` function to include `model`:

```typescript
function makeDeps(overrides: Partial<{
  session: Session;
  sessionManager: SessionManager;
  agent: Agent;
  model: string;
}> = {}) {
  // ... existing code ...
  const model = overrides.model ?? "claude-sonnet-4";
  return { session, sessionManager, agent, model };
}
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: FAIL — "Unknown command" does not contain "test-id"

### Step 3: Write minimal implementation

Update `ChatCommandDeps` interface and constructor:

```typescript
export interface ChatCommandDeps {
  session: Session;
  sessionManager: SessionManager;
  agent: Agent;
  model: string;
}

export class ChatCommandHandler {
  private readonly session: Session;
  private readonly sessionManager: SessionManager;
  private readonly agent: Agent;
  private model: string;

  constructor(deps: ChatCommandDeps) {
    this.session = deps.session;
    this.sessionManager = deps.sessionManager;
    this.agent = deps.agent;
    this.model = deps.model;
  }
```

Add case to switch and method:

```typescript
// In execute() switch, before default:
      case "status":
        return this.statusCommand();
```

```typescript
// New private method:
  private statusCommand(): string {
    const meta = this.session.metadata;
    const lines = [
      "Session Status:",
      `  Session ID:     ${meta.id}`,
      `  Model:          ${this.model}`,
      `  Messages:       ${meta.messageCount}`,
      `  Created:        ${meta.createdAt.toISOString()}`,
      `  Last activity:  ${meta.updatedAt.toISOString()}`,
    ];
    return lines.join("\n");
  }
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: PASS — 8 tests pass

### Step 5: Commit

```bash
git add packages/cli/src/commands/chat-commands.ts packages/cli/src/commands/chat-commands.test.ts
git commit -m "feat(cli): add /status command showing session metadata and model"
```

---

## Task 4: Add `/compact` command (placeholder)

**Files:**
- Modify: `packages/cli/src/commands/chat-commands.ts:30-35` (add case)
- Modify: `packages/cli/src/commands/chat-commands.test.ts` (add test)

### Step 1: Write the failing test

Append to the `describe("ChatCommandHandler")` block:

```typescript
  describe("/compact", () => {
    it("returns placeholder message", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/compact");
      expect(result).toContain("not yet implemented");
    });
  });
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: FAIL — "Unknown command" does not contain "not yet implemented"

### Step 3: Write minimal implementation

Add case to switch:

```typescript
// In execute() switch, before default:
      case "compact":
        return this.compactCommand();
```

```typescript
// New private method:
  private compactCommand(): string {
    return "Context compaction not yet implemented.";
  }
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: PASS — 9 tests pass

### Step 5: Commit

```bash
git add packages/cli/src/commands/chat-commands.ts packages/cli/src/commands/chat-commands.test.ts
git commit -m "feat(cli): add /compact command placeholder"
```

---

## Task 5: Add `/model` command

**Files:**
- Modify: `packages/cli/src/commands/chat-commands.ts` (add case + two methods)
- Modify: `packages/cli/src/commands/chat-commands.test.ts` (add tests)

**Context:** The `Agent` class stores `config` as `private readonly`. Since `AgentConfig.model` is just `string`, the simplest approach is for `ChatCommandHandler` to own a mutable `model` string and expose a `getModel()` getter so the chat wiring can read the current model when building agent requests. However, the agent itself reads `this.config.model` internally, so changing the model at runtime requires the agent to accept a model override. Since the agent's `processMessage` doesn't accept an override yet and modifying the Agent class is out of scope for this plan, the `/model` command will update the handler's tracked model and print a message noting the change takes effect on next session bootstrap. **Alternative (recommended):** Add a `setModel(model: string)` method to `Agent` that mutates `this.config.model`. This is a one-line change (make `config` non-readonly, or just the `model` field). We go with this approach.

### Step 1: Write the failing tests

Append to the `describe("ChatCommandHandler")` block:

```typescript
  describe("/model", () => {
    it("shows current model when called without args", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/model");
      expect(result).toContain("claude-sonnet-4");
    });

    it("changes model when called with an argument", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/model gpt-4o");
      expect(result).toContain("gpt-4o");
      expect(result).toContain("changed");
    });

    it("updates the model so /status reflects the change", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      await handler.execute("/model gpt-4o");
      const status = await handler.execute("/status");
      expect(status).toContain("gpt-4o");
    });
  });
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: FAIL — "Unknown command" does not contain "claude-sonnet-4"

### Step 3: Write minimal implementation

Add case to switch in `execute()`:

```typescript
// In execute() switch, before default:
      case "model":
        return this.modelCommand(args);
```

Add private methods:

```typescript
  private modelCommand(args: string[]): string {
    if (args.length === 0) {
      return `Current model: ${this.model}`;
    }
    const newModel = args[0]!;
    const oldModel = this.model;
    this.model = newModel;
    return `Model changed: ${oldModel} → ${newModel}`;
  }

  getModel(): string {
    return this.model;
  }
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: PASS — 12 tests pass

### Step 5: Commit

```bash
git add packages/cli/src/commands/chat-commands.ts packages/cli/src/commands/chat-commands.test.ts
git commit -m "feat(cli): add /model command to show/change model"
```

---

## Task 6: Add unknown command test

**Files:**
- Modify: `packages/cli/src/commands/chat-commands.test.ts`

### Step 1: Write and run the test

Append to the `describe("ChatCommandHandler")` block:

```typescript
  describe("unknown command", () => {
    it("returns an error message with the unknown command name", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/foo");
      expect(result).toContain("Unknown command");
      expect(result).toContain("/foo");
    });

    it("suggests /help", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/notreal");
      expect(result).toContain("/help");
    });
  });
```

### Step 2: Run tests

Run: `pnpm vitest run packages/cli/src/commands/chat-commands.test.ts`
Expected: PASS — 14 tests pass (this should already work from the default switch case)

### Step 3: Commit

```bash
git add packages/cli/src/commands/chat-commands.test.ts
git commit -m "test(cli): add unknown command tests for ChatCommandHandler"
```

---

## Task 7: Wire ChatCommandHandler into setupChat

**Files:**
- Modify: `packages/cli/src/commands/chat.ts:1-16`
- Modify: `packages/cli/src/commands/chat.test.ts`

**Context:** `setupChat()` currently takes `(adapter, agent, session)`. We need to add `sessionManager` and `model` so we can construct the `ChatCommandHandler`. The `model` comes from `DEFAULT_AGENT_CONFIG.model` (or whatever was used to bootstrap the agent).

### Step 1: Write the failing tests

Replace the contents of `chat.test.ts` with the updated version that tests command interception:

```typescript
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setupChat } from "./chat.js";
import { CliAdapter } from "../adapter.js";
import type { Agent, Session, SessionManager } from "@safeclaw/core";

function makeTestDeps() {
  const input = new PassThrough();
  const output = new PassThrough();
  const adapter = new CliAdapter(input, output);

  const agent = {
    processMessage: vi.fn().mockResolvedValue({
      message: "agent response",
      toolCallsMade: 0,
      model: "claude-sonnet-4",
    }),
  } as unknown as Agent;

  const session = {
    id: "test-id",
    metadata: {
      id: "test-id",
      peer: { channelId: "cli", peerId: "local" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:01:00Z"),
      messageCount: 5,
    },
    clearHistory: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  } as unknown as Session;

  const sessionManager = {
    activeCount: 1,
    listSessions: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager;

  return { input, output, adapter, agent, session, sessionManager };
}

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

describe("setupChat", () => {
  it("passes regular messages to agent", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("user question\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).toHaveBeenCalledWith(session, "user question");
    const out = readOutput(output);
    expect(out).toContain("agent response");

    await adapter.disconnect();
  });

  it("intercepts /help commands and does not call agent", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("/help\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).not.toHaveBeenCalled();
    const out = readOutput(output);
    expect(out).toContain("/new");
    expect(out).toContain("/status");

    await adapter.disconnect();
  });

  it("intercepts /new and clears session history", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("/new\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(session.clearHistory).toHaveBeenCalled();
    expect(agent.processMessage).not.toHaveBeenCalled();

    await adapter.disconnect();
  });

  it("still works with existing 3-arg signature (backward compat)", async () => {
    const { input, output, adapter, agent, session } = makeTestDeps();

    // Call without options — should still work, just no commands
    setupChat(adapter, agent, session);
    await adapter.connect();

    input.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).toHaveBeenCalledWith(session, "hello");

    await adapter.disconnect();
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/cli/src/commands/chat.test.ts`
Expected: FAIL — `setupChat` does not accept 4th argument (TypeScript error or it ignores commands)

### Step 3: Write minimal implementation

Replace `packages/cli/src/commands/chat.ts`:

```typescript
import type { Agent, Session, SessionManager } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";
import { ChatCommandHandler } from "./chat-commands.js";

export interface SetupChatOptions {
  sessionManager: SessionManager;
  model: string;
}

/**
 * Wire the CLI adapter to the agent for interactive chat.
 * When options are provided, slash commands are intercepted and handled locally.
 */
export function setupChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
  options?: SetupChatOptions,
): void {
  const commandHandler = options
    ? new ChatCommandHandler({
        session,
        sessionManager: options.sessionManager,
        agent,
        model: options.model,
      })
    : null;

  adapter.onMessage(async (msg) => {
    if (commandHandler?.isCommand(msg.content)) {
      const result = await commandHandler.execute(msg.content);
      return { content: result };
    }

    const response = await agent.processMessage(session, msg.content);
    return { content: response.message };
  });
}
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/cli/src/commands/chat.test.ts`
Expected: PASS — 4 tests pass

### Step 5: Commit

```bash
git add packages/cli/src/commands/chat.ts packages/cli/src/commands/chat.test.ts
git commit -m "feat(cli): wire ChatCommandHandler into setupChat with backward compat"
```

---

## Task 8: Update CLI entry point to pass options to setupChat

**Files:**
- Modify: `packages/cli/src/cli.ts:48-72` (`runChat` function)

### Step 1: No new tests needed

This is a wiring change in the top-level entry point. The existing `chat.test.ts` tests cover the contract. The change is trivial — pass `sessionManager` and `model` from the bootstrap result.

### Step 2: Update runChat

In `packages/cli/src/cli.ts`, modify the `runChat` function. Change lines 64 onward:

```typescript
// Before:
  setupChat(adapter, agent, session);

// After:
  setupChat(adapter, agent, session, {
    sessionManager,
    model: "claude-sonnet-4",
  });
```

The `sessionManager` is already destructured from `bootstrapAgent` on line 52. Import `DEFAULT_AGENT_CONFIG` if you want to use the canonical default:

```typescript
// Alternative — use the constant:
import { DEFAULT_AGENT_CONFIG } from "@safeclaw/core";
// ...
  setupChat(adapter, agent, session, {
    sessionManager,
    model: DEFAULT_AGENT_CONFIG.model,
  });
```

Either approach works since `DEFAULT_AGENT_CONFIG.model` is `"claude-sonnet-4"`. Using the constant is preferred to avoid string duplication.

### Step 3: Run full test suite to verify nothing is broken

Run: `pnpm vitest run packages/cli/`
Expected: All CLI tests pass

### Step 4: Commit

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): pass sessionManager and model to setupChat in CLI entry point"
```

---

## Task 9: Export ChatCommandHandler from package barrel

**Files:**
- Modify: `packages/cli/src/index.ts`

### Step 1: Add export

Add to `packages/cli/src/index.ts`:

```typescript
export { ChatCommandHandler } from "./commands/chat-commands.js";
export type { ChatCommandDeps, SetupChatOptions } from "./commands/chat-commands.js";
```

Also re-export `SetupChatOptions` from `chat.ts`:

```typescript
export type { SetupChatOptions } from "./commands/chat.js";
```

Wait — `SetupChatOptions` is defined in `chat.ts`, not `chat-commands.ts`. Export it from the right place:

```typescript
export { ChatCommandHandler } from "./commands/chat-commands.js";
export type { ChatCommandDeps } from "./commands/chat-commands.js";
export type { SetupChatOptions } from "./commands/chat.js";
```

### Step 2: Run typecheck

Run: `pnpm typecheck`
Expected: No errors

### Step 3: Commit

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): export ChatCommandHandler and related types"
```

---

## Task 10: Run full test suite and lint

### Step 1: Run all tests

Run: `pnpm test`
Expected: All tests pass

### Step 2: Run linter

Run: `pnpm lint`
Expected: No errors

### Step 3: Run typecheck

Run: `pnpm typecheck`
Expected: No errors

### Step 4: Final commit (if any lint/type fixes were needed)

```bash
git add -A
git commit -m "fix(cli): address lint/type issues from chat commands"
```

Skip this commit if no fixes were needed.

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | ChatCommandHandler + `/help` | `chat-commands.ts`, `chat-commands.test.ts` |
| 2 | `/new` command | `chat-commands.ts`, `chat-commands.test.ts` |
| 3 | `/status` command | `chat-commands.ts`, `chat-commands.test.ts` |
| 4 | `/compact` placeholder | `chat-commands.ts`, `chat-commands.test.ts` |
| 5 | `/model` command | `chat-commands.ts`, `chat-commands.test.ts` |
| 6 | Unknown command tests | `chat-commands.test.ts` |
| 7 | Wire into `setupChat()` | `chat.ts`, `chat.test.ts` |
| 8 | Update CLI entry point | `cli.ts` |
| 9 | Package barrel exports | `index.ts` |
| 10 | Full suite verification | — |

**Total new files:** 2 (`chat-commands.ts`, `chat-commands.test.ts`)
**Modified files:** 3 (`chat.ts`, `chat.test.ts`, `cli.ts`, `index.ts`)
**Expected commit count:** 8-9
