# Context Compaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically summarize older conversation messages when approaching token limits to keep conversations within context windows.

**Architecture:** Create a `ContextCompactor` class that monitors `prompt_tokens` from LLM responses and, when usage exceeds 80% of a configurable `maxContextTokens` threshold, replaces older messages with a single LLM-generated summary. The compactor preserves the most recent N messages (default 10) to maintain conversational continuity and ensures tool-call/tool-result pairs are never split. The same `CopilotClient` used for chat powers the summarization request.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Add `maxContextTokens` to `AgentConfig`

**Files:**
- Modify: `packages/core/src/agent/types.ts:3-10` (add field to `AgentConfig`)
- Modify: `packages/core/src/agent/types.ts:18-26` (add default to `DEFAULT_AGENT_CONFIG`)

### Step 1: Add the field and default

In `packages/core/src/agent/types.ts`, add `maxContextTokens` to the `AgentConfig` interface and its default:

```typescript
export interface AgentConfig {
  model: CopilotModel;
  systemPrompt: string;
  maxToolRounds: number;
  skillId: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  maxContextTokens?: number | undefined;
}
```

```typescript
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: "claude-sonnet-4",
  systemPrompt:
    "You are SafeClaw, a secure AI assistant. Follow user instructions carefully.",
  maxToolRounds: 10,
  skillId: "builtin",
  temperature: undefined,
  maxTokens: undefined,
  maxContextTokens: 100_000,
};
```

### Step 2: Verify existing tests still pass

Run: `pnpm vitest run packages/core/src/agent/agent.test.ts`
Expected: All pass (new field is optional, default unchanged).

### Step 3: Commit

```bash
git add packages/core/src/agent/types.ts
git commit -m "feat(core): add maxContextTokens to AgentConfig"
```

---

## Task 2: Add `setHistory` method to `Session`

The `ContextCompactor` needs to replace session history with compacted messages. Currently `Session` only has `getHistory()`, `addMessage()`, and `clearHistory()`. We need `setHistory()`.

**Files:**
- Modify: `packages/core/src/sessions/session.ts:46-49`
- Test: `packages/core/src/sessions/session.test.ts`

### Step 1: Write the failing test

Add this test to `packages/core/src/sessions/session.test.ts`:

```typescript
describe("setHistory", () => {
  it("replaces all messages with provided array", () => {
    const session = new Session("s1", { type: "cli", id: "user1" });
    session.addMessage({ role: "user", content: "old message" });
    session.addMessage({ role: "assistant", content: "old reply" });

    const newHistory: ChatMessage[] = [
      { role: "user", content: "summary of old conversation" },
      { role: "user", content: "recent message" },
      { role: "assistant", content: "recent reply" },
    ];
    session.setHistory(newHistory);

    const history = session.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0]!.content).toBe("summary of old conversation");
  });

  it("defensive-copies input messages", () => {
    const session = new Session("s1", { type: "cli", id: "user1" });
    const msgs: ChatMessage[] = [{ role: "user", content: "hello" }];
    session.setHistory(msgs);

    msgs[0]!.content = "mutated";
    expect(session.getHistory()[0]!.content).toBe("hello");
  });

  it("updates the updatedAt timestamp", () => {
    const session = new Session("s1", { type: "cli", id: "user1" });
    const before = session.metadata.updatedAt;

    // Small delay to ensure timestamp difference
    session.setHistory([{ role: "user", content: "new" }]);
    const after = session.metadata.updatedAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
```

You will need to import `ChatMessage` at the top of the test file if not already imported:

```typescript
import type { ChatMessage } from "../copilot/types.js";
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/core/src/sessions/session.test.ts`
Expected: FAIL — `session.setHistory is not a function`

### Step 3: Implement `setHistory`

In `packages/core/src/sessions/session.ts`, add after the `clearHistory` method (after line 49):

```typescript
setHistory(messages: ChatMessage[]): void {
  this.#history = messages.map((m) => ({ ...m }));
  this.#updatedAt = new Date();
}
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run packages/core/src/sessions/session.test.ts`
Expected: All PASS

### Step 5: Commit

```bash
git add packages/core/src/sessions/session.ts packages/core/src/sessions/session.test.ts
git commit -m "feat(core): add setHistory method to Session"
```

---

## Task 3: Create `ContextCompactor` — token estimation and threshold check

**Files:**
- Create: `packages/core/src/agent/compactor.ts`
- Create: `packages/core/src/agent/compactor.test.ts`

### Step 1: Write the failing tests for `estimateTokens` and `shouldCompact`

Create `packages/core/src/agent/compactor.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ContextCompactor } from "./compactor.js";
import type { CopilotClient } from "../copilot/client.js";
import type { ChatMessage } from "../copilot/types.js";

function makeCompactor(overrides: { maxContextTokens?: number; preserveRecentMessages?: number } = {}) {
  const client = { chat: vi.fn() } as unknown as CopilotClient;
  return new ContextCompactor({
    client,
    model: "claude-sonnet-4",
    maxContextTokens: overrides.maxContextTokens ?? 1000,
    preserveRecentMessages: overrides.preserveRecentMessages ?? 10,
  });
}

describe("ContextCompactor", () => {
  describe("estimateTokens", () => {
    it("estimates roughly 1 token per 4 characters", () => {
      const compactor = makeCompactor();
      // 40 chars of content → ~10 tokens, plus role/structure overhead
      const messages: ChatMessage[] = [
        { role: "user", content: "a".repeat(40) },
      ];
      const estimate = compactor.estimateTokens(messages);
      // Should be roughly 10 + overhead per message (4 tokens for role/structure)
      expect(estimate).toBeGreaterThanOrEqual(10);
      expect(estimate).toBeLessThan(30);
    });

    it("returns 0 for empty message array", () => {
      const compactor = makeCompactor();
      expect(compactor.estimateTokens([])).toBe(0);
    });

    it("accounts for tool_calls JSON in estimation", () => {
      const compactor = makeCompactor();
      const withoutToolCalls: ChatMessage[] = [
        { role: "assistant", content: "hello" },
      ];
      const withToolCalls: ChatMessage[] = [
        {
          role: "assistant",
          content: "hello",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/test"}' } },
          ],
        },
      ];
      expect(compactor.estimateTokens(withToolCalls)).toBeGreaterThan(
        compactor.estimateTokens(withoutToolCalls),
      );
    });
  });

  describe("shouldCompact", () => {
    it("returns false when token count is below 80% threshold", () => {
      const compactor = makeCompactor({ maxContextTokens: 1000 });
      expect(compactor.shouldCompact(799)).toBe(false);
    });

    it("returns true when token count is at 80% threshold", () => {
      const compactor = makeCompactor({ maxContextTokens: 1000 });
      expect(compactor.shouldCompact(800)).toBe(true);
    });

    it("returns true when token count exceeds 80% threshold", () => {
      const compactor = makeCompactor({ maxContextTokens: 1000 });
      expect(compactor.shouldCompact(900)).toBe(true);
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm vitest run packages/core/src/agent/compactor.test.ts`
Expected: FAIL — cannot import `ContextCompactor`

### Step 3: Implement `ContextCompactor` skeleton

Create `packages/core/src/agent/compactor.ts`:

```typescript
import type { CopilotClient } from "../copilot/client.js";
import type { ChatMessage, CopilotModel } from "../copilot/types.js";

export interface ContextCompactorConfig {
  client: CopilotClient;
  model: CopilotModel;
  maxContextTokens: number;
  preserveRecentMessages: number;
}

export class ContextCompactor {
  private readonly client: CopilotClient;
  private readonly model: CopilotModel;
  private readonly maxContextTokens: number;
  private readonly preserveRecentMessages: number;

  constructor(config: ContextCompactorConfig) {
    this.client = config.client;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens;
    this.preserveRecentMessages = config.preserveRecentMessages;
  }

  /**
   * Rough token estimate: ~1 token per 4 characters of content,
   * plus 4 tokens overhead per message for role/structure.
   */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // Content tokens
      total += Math.ceil(msg.content.length / 4);
      // Overhead per message (role, separators)
      total += 4;
      // tool_calls contribute additional tokens
      if (msg.tool_calls) {
        const serialized = JSON.stringify(msg.tool_calls);
        total += Math.ceil(serialized.length / 4);
      }
    }
    return total;
  }

  /**
   * Returns true when prompt_tokens exceeds 80% of maxContextTokens.
   */
  shouldCompact(tokenCount: number): boolean {
    return tokenCount >= this.maxContextTokens * 0.8;
  }
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/core/src/agent/compactor.test.ts`
Expected: All PASS

### Step 5: Commit

```bash
git add packages/core/src/agent/compactor.ts packages/core/src/agent/compactor.test.ts
git commit -m "feat(core): add ContextCompactor with token estimation and threshold"
```

---

## Task 4: Implement `compact()` method — message splitting and LLM summarization

**Files:**
- Modify: `packages/core/src/agent/compactor.ts`
- Modify: `packages/core/src/agent/compactor.test.ts`

### Step 1: Write the failing tests for `compact()`

Add to `packages/core/src/agent/compactor.test.ts`, inside the existing `describe("ContextCompactor", ...)` block:

```typescript
describe("compact", () => {
  it("preserves the last N messages and summarizes the rest", async () => {
    const client = { chat: vi.fn() } as unknown as CopilotClient;
    const compactor = new ContextCompactor({
      client,
      model: "claude-sonnet-4",
      maxContextTokens: 1000,
      preserveRecentMessages: 2,
    });

    const history: ChatMessage[] = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "Recent question" },
      { role: "assistant", content: "Recent answer" },
    ];

    vi.mocked(client.chat).mockResolvedValue({
      id: "resp-summary",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Summary: User asked two questions and got answers." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    const result = await compactor.compact(history);

    // Should have: 1 summary message + 2 preserved messages
    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toContain("[Previous conversation summary]");
    expect(result[0]!.content).toContain("Summary: User asked two questions and got answers.");
    // Recent messages preserved
    expect(result[1]!.content).toBe("Recent question");
    expect(result[2]!.content).toBe("Recent answer");
  });

  it("does not split assistant+tool_calls from following tool results", async () => {
    const client = { chat: vi.fn() } as unknown as CopilotClient;
    const compactor = new ContextCompactor({
      client,
      model: "claude-sonnet-4",
      maxContextTokens: 1000,
      preserveRecentMessages: 2,
    });

    // History where the 3rd-from-last message is a tool result
    // that pairs with a preceding assistant+tool_calls message.
    // preserveRecentMessages=2 would naively split them.
    const history: ChatMessage[] = [
      { role: "user", content: "Old message" },
      { role: "assistant", content: "Old reply" },
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp"}' } }],
      },
      { role: "tool", content: "file contents here", tool_call_id: "call_1" },
      { role: "assistant", content: "Here is what I found" },
    ];

    vi.mocked(client.chat).mockResolvedValue({
      id: "resp-summary",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Summary of old conversation." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    const result = await compactor.compact(history);

    // The tool-call group (assistant+tool_calls, tool result, final assistant)
    // should be kept together. With preserveRecentMessages=2,
    // the split point must back up to include the full tool-call group.
    // Preserved: messages[2..5] (user "Do something", assistant+tool_calls, tool result, final assistant)
    // Summarized: messages[0..1]
    expect(result.length).toBeGreaterThanOrEqual(3);
    // No tool result should appear in summarized portion
    const summaryMsg = result[0]!;
    expect(summaryMsg.content).toContain("[Previous conversation summary]");
    // The tool result and its assistant should be in preserved portion
    const preserved = result.slice(1);
    const hasToolResult = preserved.some((m) => m.role === "tool");
    const hasToolCalls = preserved.some((m) => m.tool_calls && m.tool_calls.length > 0);
    expect(hasToolResult).toBe(true);
    expect(hasToolCalls).toBe(true);
  });

  it("returns history unchanged when too few messages to compact", async () => {
    const client = { chat: vi.fn() } as unknown as CopilotClient;
    const compactor = new ContextCompactor({
      client,
      model: "claude-sonnet-4",
      maxContextTokens: 1000,
      preserveRecentMessages: 10,
    });

    const history: ChatMessage[] = [
      { role: "user", content: "Short conversation" },
      { role: "assistant", content: "Short reply" },
    ];

    const result = await compactor.compact(history);

    // Fewer messages than preserveRecentMessages → return unchanged
    expect(result).toEqual(history);
    // Should NOT have called the LLM
    expect(client.chat).not.toHaveBeenCalled();
  });

  it("sends old messages to LLM with summarization prompt", async () => {
    const client = { chat: vi.fn() } as unknown as CopilotClient;
    const compactor = new ContextCompactor({
      client,
      model: "claude-sonnet-4",
      maxContextTokens: 1000,
      preserveRecentMessages: 1,
    });

    const history: ChatMessage[] = [
      { role: "user", content: "Tell me about X" },
      { role: "assistant", content: "X is a thing that does Y" },
      { role: "user", content: "Thanks" },
    ];

    vi.mocked(client.chat).mockResolvedValue({
      id: "resp-summary",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "User asked about X. Assistant explained X does Y." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    await compactor.compact(history);

    // Verify LLM was called with summarization system prompt and old messages
    const chatCall = vi.mocked(client.chat).mock.calls[0]![0];
    expect(chatCall.model).toBe("claude-sonnet-4");
    expect(chatCall.messages[0]!.role).toBe("system");
    expect(chatCall.messages[0]!.content).toContain("summarize");
    // Old messages should be included
    const msgContents = chatCall.messages.map((m) => m.content);
    expect(msgContents.some((c) => c.includes("Tell me about X"))).toBe(true);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm vitest run packages/core/src/agent/compactor.test.ts`
Expected: FAIL — `compactor.compact is not a function`

### Step 3: Implement `compact()` method

Add to `packages/core/src/agent/compactor.ts`, inside the `ContextCompactor` class, after `shouldCompact`:

```typescript
/**
 * Compact conversation history by summarizing older messages.
 *
 * 1. Split history into "old" (to summarize) and "recent" (to preserve).
 * 2. Adjust the split point so tool-call/tool-result pairs are never broken.
 * 3. Send old messages to LLM for summarization.
 * 4. Return [summary_message, ...recent_messages].
 */
async compact(history: ChatMessage[]): Promise<ChatMessage[]> {
  // Not enough messages to compact
  if (history.length <= this.preserveRecentMessages) {
    return history;
  }

  // Find the split point
  let splitIndex = history.length - this.preserveRecentMessages;

  // Adjust split point backwards to avoid breaking tool-call groups.
  // A tool-call group is: assistant with tool_calls → one or more tool results.
  // If the split lands inside a group, back up to include the whole group.
  splitIndex = this.adjustSplitForToolGroups(history, splitIndex);

  // If adjustment consumed everything, nothing to summarize
  if (splitIndex <= 0) {
    return history;
  }

  const oldMessages = history.slice(0, splitIndex);
  const recentMessages = history.slice(splitIndex);

  // Summarize old messages via LLM
  const summary = await this.summarize(oldMessages);

  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Previous conversation summary]\n${summary}`,
  };

  return [summaryMessage, ...recentMessages];
}

/**
 * Adjust split index backwards so we don't break apart
 * assistant+tool_calls / tool-result groups.
 */
private adjustSplitForToolGroups(
  history: ChatMessage[],
  splitIndex: number,
): number {
  // If the message at splitIndex is a tool result, back up to include
  // the preceding assistant+tool_calls message and all related tool results.
  while (splitIndex > 0 && history[splitIndex]?.role === "tool") {
    splitIndex--;
  }
  // If we landed on an assistant with tool_calls, include it too
  while (
    splitIndex > 0 &&
    history[splitIndex]?.role === "assistant" &&
    history[splitIndex]?.tool_calls &&
    history[splitIndex]!.tool_calls!.length > 0
  ) {
    splitIndex--;
  }
  return splitIndex;
}

/**
 * Call the LLM to produce a concise summary of the given messages.
 */
private async summarize(messages: ChatMessage[]): Promise<string> {
  // Build a text representation of old messages for summarization.
  // Strip tool_calls metadata — just include the content.
  const conversationText = messages
    .map((m) => {
      const prefix = m.role === "tool" ? "tool-result" : m.role;
      return `[${prefix}]: ${m.content}`;
    })
    .join("\n");

  const response = await this.client.chat({
    model: this.model,
    messages: [
      {
        role: "system",
        content:
          "You are a conversation summarizer. Summarize the following conversation concisely. " +
          "Preserve key facts, decisions, file paths, code snippets, and any important context " +
          "the user or assistant referenced. Be factual and brief. Output only the summary.",
      },
      {
        role: "user",
        content: conversationText,
      },
    ],
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error("No choices in summarization response");
  }
  return choice.message.content;
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/core/src/agent/compactor.test.ts`
Expected: All PASS

### Step 5: Commit

```bash
git add packages/core/src/agent/compactor.ts packages/core/src/agent/compactor.test.ts
git commit -m "feat(core): implement compact() with LLM summarization and tool-group safety"
```

---

## Task 5: Integrate `ContextCompactor` into the Agent loop

**Files:**
- Modify: `packages/core/src/agent/agent.ts:11-24` (add compactor field, update constructor)
- Modify: `packages/core/src/agent/agent.ts:56-62` (add compaction check after response)
- Modify: `packages/core/src/agent/agent.test.ts`

### Step 1: Write the failing test

Add to `packages/core/src/agent/agent.test.ts`, inside the existing `describe("Agent", ...)` block. First add the import at the top:

```typescript
import type { ContextCompactor } from "./compactor.js";
```

Then add the test:

```typescript
describe("context compaction", () => {
  it("compacts session history when prompt_tokens exceeds threshold", async () => {
    const { session, client, orchestrator, toolRegistry, history } = createMocks();
    vi.mocked(toolRegistry.list).mockReturnValue([]);

    // Return high token usage that triggers compaction
    vi.mocked(client.chat).mockResolvedValue({
      id: "resp-1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 85000, completion_tokens: 100, total_tokens: 85100 },
    });

    const compactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn().mockResolvedValue([
        { role: "user", content: "[Previous conversation summary]\nSummary here." },
        { role: "user", content: "Latest message" },
      ]),
    } as unknown as ContextCompactor;

    const agent = new Agent(makeConfig(), client, orchestrator, compactor);
    await agent.processMessage(session, "Hello");

    expect(compactor.shouldCompact).toHaveBeenCalledWith(85000);
    expect(compactor.compact).toHaveBeenCalled();
    // Session history should have been replaced via setHistory
    expect(session.setHistory).toBeDefined();
  });

  it("does not compact when prompt_tokens is below threshold", async () => {
    const { session, client, orchestrator, toolRegistry } = createMocks();
    vi.mocked(toolRegistry.list).mockReturnValue([]);

    vi.mocked(client.chat).mockResolvedValue(
      makeResponse("Hello there!"),
    );

    const compactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    } as unknown as ContextCompactor;

    const agent = new Agent(makeConfig(), client, orchestrator, compactor);
    await agent.processMessage(session, "Hi");

    expect(compactor.shouldCompact).toHaveBeenCalledWith(10); // from makeResponse usage
    expect(compactor.compact).not.toHaveBeenCalled();
  });

  it("works without a compactor (backward compatible)", async () => {
    const { session, client, orchestrator, toolRegistry } = createMocks();
    vi.mocked(toolRegistry.list).mockReturnValue([]);
    vi.mocked(client.chat).mockResolvedValue(makeResponse("Hello!"));

    // No compactor passed — should work fine
    const agent = new Agent(makeConfig(), client, orchestrator);
    const result = await agent.processMessage(session, "Hi");

    expect(result.message).toBe("Hello!");
  });
});
```

Also update `createMocks` to include `setHistory` on the session mock:

```typescript
// In createMocks(), update the session mock:
const session = {
  addMessage: vi.fn((msg: ChatMessage) => {
    history.push(msg);
  }),
  getHistory: vi.fn(() => [...history]),
  setHistory: vi.fn((msgs: ChatMessage[]) => {
    history.length = 0;
    history.push(...msgs);
  }),
} as unknown as Session;
```

### Step 2: Run tests to verify they fail

Run: `pnpm vitest run packages/core/src/agent/agent.test.ts`
Expected: FAIL — `Agent` constructor does not accept 4th argument

### Step 3: Update `Agent` to accept and use `ContextCompactor`

Modify `packages/core/src/agent/agent.ts`:

Add the import at the top:

```typescript
import type { ContextCompactor } from "./compactor.js";
```

Update the class fields and constructor (lines 11-24):

```typescript
export class Agent {
  private readonly config: AgentConfig;
  private readonly client: CopilotClient;
  private readonly orchestrator: ToolOrchestrator;
  private readonly compactor?: ContextCompactor;

  constructor(
    config: AgentConfig,
    client: CopilotClient,
    orchestrator: ToolOrchestrator,
    compactor?: ContextCompactor,
  ) {
    this.config = config;
    this.client = client;
    this.orchestrator = orchestrator;
    this.compactor = compactor;
  }
```

After `const response = await this.client.chat(request);` (line 57), add compaction logic:

```typescript
const response = await this.client.chat(request);

// Check if context compaction is needed
if (this.compactor && this.compactor.shouldCompact(response.usage.prompt_tokens)) {
  const compacted = await this.compactor.compact(session.getHistory());
  session.setHistory(compacted);
}

const choice = response.choices[0];
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/core/src/agent/agent.test.ts`
Expected: All PASS (old tests still pass since compactor is optional)

### Step 5: Commit

```bash
git add packages/core/src/agent/agent.ts packages/core/src/agent/agent.test.ts
git commit -m "feat(core): integrate ContextCompactor into Agent loop"
```

---

## Task 6: Export `ContextCompactor` from package barrel

**Files:**
- Modify: `packages/core/src/agent/index.ts`

### Step 1: Add the export

In `packages/core/src/agent/index.ts`, add:

```typescript
export { Agent } from "./agent.js";
export { ContextCompactor } from "./compactor.js";
export { DEFAULT_AGENT_CONFIG } from "./types.js";
export type { AgentConfig, AgentResponse } from "./types.js";
export type { ContextCompactorConfig } from "./compactor.js";
```

### Step 2: Verify build succeeds

Run: `pnpm build`
Expected: Build completes without errors.

### Step 3: Commit

```bash
git add packages/core/src/agent/index.ts
git commit -m "feat(core): export ContextCompactor from package barrel"
```

---

## Task 7: Wire `ContextCompactor` in bootstrap

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:1-9` (add import)
- Modify: `packages/cli/src/commands/bootstrap.ts:172-183` (create compactor, pass to Agent)

### Step 1: Update bootstrap to create and inject `ContextCompactor`

Add to the import from `@safeclaw/core`:

```typescript
import {
  Agent,
  DEFAULT_AGENT_CONFIG,
  CopilotClient,
  getCopilotToken as defaultGetCopilotToken,
  SessionManager,
  CapabilityRegistry,
  CapabilityEnforcer,
  SimpleToolRegistry,
  ToolOrchestrator,
  createBuiltinTools,
  AuditLog,
  SkillLoader,
  ContextCompactor,
} from "@safeclaw/core";
```

Update the Agent construction (around lines 179-183):

```typescript
const compactor = new ContextCompactor({
  client,
  model,
  maxContextTokens: DEFAULT_AGENT_CONFIG.maxContextTokens ?? 100_000,
  preserveRecentMessages: 10,
});
const agent = new Agent(
  { ...DEFAULT_AGENT_CONFIG, model, skillId: manifest.id },
  client,
  orchestrator,
  compactor,
);
```

### Step 2: Run existing bootstrap tests

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: All PASS (the tests mock Agent constructor; adding an argument should be fine).

If any test fails because of the extra constructor argument, update the relevant mock to accept the 4th argument.

### Step 3: Commit

```bash
git add packages/cli/src/commands/bootstrap.ts
git commit -m "feat(cli): wire ContextCompactor in bootstrap"
```

---

## Task 8: Full test suite and typecheck verification

### Step 1: Run full type check

Run: `pnpm typecheck`
Expected: No type errors.

### Step 2: Run full test suite

Run: `pnpm test`
Expected: All tests pass.

### Step 3: Run linter

Run: `pnpm lint`
Expected: No lint errors.

### Step 4: Fix any issues found

If any step above fails, fix the issue and re-run.

### Step 5: Final commit (if fixes were needed)

```bash
git add -A
git commit -m "fix(core): resolve type/lint issues from context compaction"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add `maxContextTokens` to config | `types.ts` |
| 2 | Add `setHistory` to Session | `session.ts`, `session.test.ts` |
| 3 | Create `ContextCompactor` (estimation + threshold) | `compactor.ts`, `compactor.test.ts` |
| 4 | Implement `compact()` with LLM summarization | `compactor.ts`, `compactor.test.ts` |
| 5 | Integrate compactor into Agent loop | `agent.ts`, `agent.test.ts` |
| 6 | Export from barrel | `agent/index.ts` |
| 7 | Wire in bootstrap | `bootstrap.ts` |
| 8 | Full verification | — |
