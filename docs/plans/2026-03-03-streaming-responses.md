# Streaming Responses Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the existing `CopilotClient.chatStream()` into the agent loop and CLI adapter so assistant text streams token-by-token to the terminal.

**Architecture:** Add a `processMessageStream()` async generator method to `Agent` that mirrors the existing `processMessage()` loop but calls `this.client.chatStream()` instead of `this.client.chat()`. The generator yields typed `AgentStreamEvent` discriminated union events (`text_delta`, `tool_start`, `tool_result`, `done`, `error`). The CLI adapter gets a new `onStreamMessage()` registration method and `handleLine()` dispatches to the stream handler, writing text deltas directly to the output stream as they arrive. Tools still execute synchronously (no streaming for tool execution).

**Tech Stack:** TypeScript, AsyncGenerator, Vitest

---

## Task 1: Define streaming event types

**Files:**
- Modify: `packages/core/src/agent/types.ts:1-26`
- Modify: `packages/core/src/agent/index.ts:1-3`

**Step 1: Add `AgentStreamEvent` type to `types.ts`**

Append after the existing `DEFAULT_AGENT_CONFIG` (line 26):

```typescript
// --- Streaming event types ---

export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  result: string;
  success: boolean;
}

export interface DoneEvent {
  type: "done";
  response: AgentResponse;
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export type AgentStreamEvent =
  | TextDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | DoneEvent
  | ErrorEvent;
```

**Step 2: Re-export the new type from `agent/index.ts`**

Update `packages/core/src/agent/index.ts` to:

```typescript
export { Agent } from "./agent.js";
export { DEFAULT_AGENT_CONFIG } from "./types.js";
export type { AgentConfig, AgentResponse, AgentStreamEvent } from "./types.js";
```

**Step 3: Verify it type-checks**

Run: `npx tsc --build --dry`
Expected: Clean (no errors)

**Step 4: Commit**

```bash
git add packages/core/src/agent/types.ts packages/core/src/agent/index.ts
git commit -m "feat(core): add AgentStreamEvent discriminated union types"
```

---

## Task 2: Write failing tests for `processMessageStream()`

**Files:**
- Modify: `packages/core/src/agent/agent.test.ts`

The tests mock `client.chatStream` as an async generator returning `StreamChunk` objects. We add it to the mock alongside the existing `client.chat` mock.

**Step 1: Add `chatStream` to the `createMocks()` helper**

In `packages/core/src/agent/agent.test.ts`, update the import block (lines 4-8) to include `StreamChunk`:

```typescript
import type { CopilotClient } from "../copilot/client.js";
import type {
  ChatCompletionResponse,
  ChatMessage,
  StreamChunk,
} from "../copilot/types.js";
```

In `createMocks()` (line 69-71), add `chatStream` to the client mock:

```typescript
  const client = {
    chat: vi.fn(),
    chatStream: vi.fn(),
  } as unknown as CopilotClient;
```

Add a helper function after `createMocks()` (after line 88) to build `StreamChunk` arrays:

```typescript
function makeStreamChunks(
  textContent: string,
  finishReason: string | null = "stop",
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const char of textContent) {
    chunks.push({
      id: "stream-1",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: { content: char },
          finish_reason: null,
        },
      ],
    });
  }
  // Final chunk with finish_reason
  chunks.push({
    id: "stream-1",
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason ?? "stop",
      },
    ],
  });
  return chunks;
}

function makeToolCallStreamChunks(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>,
): StreamChunk[] {
  const chunks: StreamChunk[] = [];

  // Send each tool call's name and id in one chunk, arguments character-by-character
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    // First chunk: id, type, and function name
    chunks.push({
      id: "stream-1",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });

    // Argument chunks
    for (const char of tc.arguments) {
      chunks.push({
        id: "stream-1",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  function: { arguments: char },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
  }

  // Final chunk
  chunks.push({
    id: "stream-1",
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      },
    ],
  });
  return chunks;
}

async function* asyncIterableFrom<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

async function collectEvents(
  stream: AsyncIterable<import("./types.js").AgentStreamEvent>,
): Promise<import("./types.js").AgentStreamEvent[]> {
  const events: import("./types.js").AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
```

**Step 2: Add the test cases**

Add a new `describe("processMessageStream")` block after the existing `describe("processMessage")` block (after line 418), but still inside the outer `describe("Agent")`:

```typescript
  describe("processMessageStream", () => {
    it("yields text_delta events for each content chunk", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      const chunks = makeStreamChunks("Hi!");
      vi.mocked(client.chatStream).mockReturnValue(
        asyncIterableFrom(chunks),
      );

      const agent = new Agent(makeConfig(), client, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Hello"),
      );

      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas).toHaveLength(3); // "H", "i", "!"
      expect(textDeltas.map((e) => (e as { content: string }).content).join("")).toBe("Hi!");
    });

    it("emits done event with complete AgentResponse", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      const chunks = makeStreamChunks("Done.");
      vi.mocked(client.chatStream).mockReturnValue(
        asyncIterableFrom(chunks),
      );

      const agent = new Agent(makeConfig(), client, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Finish"),
      );

      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]).toEqual({
        type: "done",
        response: {
          message: "Done.",
          toolCallsMade: 0,
          model: "claude-sonnet-4",
        },
      });
    });

    it("accumulates tool calls from stream and executes them", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      // First stream: tool call
      const toolChunks = makeToolCallStreamChunks([
        {
          id: "call_s1",
          name: "read_file",
          arguments: JSON.stringify({ path: "/etc/hosts" }),
        },
      ]);

      // Second stream: final text
      const textChunks = makeStreamChunks("File contents here.");

      vi.mocked(client.chatStream)
        .mockReturnValueOnce(asyncIterableFrom(toolChunks))
        .mockReturnValueOnce(asyncIterableFrom(textChunks));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "127.0.0.1 localhost",
        durationMs: 5,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), client, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Read hosts"),
      );

      // Should see tool_start, tool_result, text_deltas, done
      const toolStarts = events.filter((e) => e.type === "tool_start");
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0]).toEqual({
        type: "tool_start",
        toolName: "read_file",
        toolCallId: "call_s1",
      });
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toEqual({
        type: "tool_result",
        toolCallId: "call_s1",
        result: "127.0.0.1 localhost",
        success: true,
      });

      expect(orchestrator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "read_file",
          args: { path: "/etc/hosts" },
        }),
      );
    });

    it("enforces maxToolRounds and emits done", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      const toolChunks = makeToolCallStreamChunks([
        {
          id: "call_loop",
          name: "read_file",
          arguments: JSON.stringify({ path: "/" }),
        },
      ]);

      // Always return tool calls
      vi.mocked(client.chatStream).mockReturnValue(
        asyncIterableFrom(toolChunks),
      );

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "ok",
        durationMs: 1,
        sandboxed: false,
      });

      const config = makeConfig({ maxToolRounds: 1 });
      const agent = new Agent(config, client, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Loop"),
      );

      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents).toHaveLength(1);
      const done = doneEvents[0] as { type: "done"; response: { message: string; toolCallsMade: number } };
      expect(done.response.message).toContain("tool");
      expect(client.chatStream).toHaveBeenCalledTimes(1);
    });

    it("emits error event on stream failure", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      async function* failingStream(): AsyncIterable<StreamChunk> {
        throw new Error("Network error");
      }

      vi.mocked(client.chatStream).mockReturnValue(failingStream());

      const agent = new Agent(makeConfig(), client, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Fail"),
      );

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toEqual({
        type: "error",
        error: "Network error",
      });
    });

    it("handles failed tool results and continues", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      const toolChunks = makeToolCallStreamChunks([
        {
          id: "call_fail",
          name: "read_file",
          arguments: JSON.stringify({ path: "/secret" }),
        },
      ]);
      const textChunks = makeStreamChunks("Access denied.");

      vi.mocked(client.chatStream)
        .mockReturnValueOnce(asyncIterableFrom(toolChunks))
        .mockReturnValueOnce(asyncIterableFrom(textChunks));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: false,
        output: "",
        error: "Permission denied",
        durationMs: 1,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), client, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Read secret"),
      );

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toEqual({
        type: "tool_result",
        toolCallId: "call_fail",
        result: "Error: Permission denied",
        success: false,
      });

      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents).toHaveLength(1);
    });
  });
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/agent/agent.test.ts`
Expected: FAIL -- `agent.processMessageStream is not a function` (method doesn't exist yet)

**Step 4: Commit**

```bash
git add packages/core/src/agent/agent.test.ts
git commit -m "test(core): add failing tests for agent streaming"
```

---

## Task 3: Implement `processMessageStream()` on Agent

**Files:**
- Modify: `packages/core/src/agent/agent.ts:1-155`

**Step 1: Add import for streaming types**

Update the import at line 9 of `packages/core/src/agent/agent.ts`:

```typescript
import type { AgentConfig, AgentResponse, AgentStreamEvent } from "./types.js";
```

Also add `StreamChunk` to the copilot types import (lines 2-6):

```typescript
import type {
  ChatCompletionRequest,
  ChatMessage,
  StreamChunk,
  ToolDefinitionParam,
} from "../copilot/types.js";
```

**Step 2: Add `processMessageStream()` method**

Add this method to the `Agent` class, after `processMessage()` (after line 130) and before `getToolDefinitions()`:

```typescript
  async *processMessageStream(
    session: Session,
    userMessage: string,
  ): AsyncGenerator<AgentStreamEvent> {
    session.addMessage({ role: "user", content: userMessage });

    let totalToolCalls = 0;
    let rounds = 0;

    try {
      for (;;) {
        const messages: ChatMessage[] = [
          { role: "system", content: this.config.systemPrompt },
          ...session.getHistory(),
        ];

        const tools = this.getToolDefinitions();
        const request: ChatCompletionRequest = {
          model: this.config.model,
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          ...(this.config.maxTokens !== undefined
            ? { max_tokens: this.config.maxTokens }
            : {}),
        };

        // Accumulate deltas from stream
        let fullContent = "";
        const toolCallAccumulator = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        let finishReason: string | null = null;

        for await (const chunk of this.client.chatStream(request)) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          // Accumulate text content
          if (choice.delta.content) {
            fullContent += choice.delta.content;
            yield { type: "text_delta", content: choice.delta.content };
          }

          // Accumulate tool calls
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const existing = toolCallAccumulator.get(tc.index);
              if (existing) {
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                toolCallAccumulator.set(tc.index, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }

        // Process accumulated tool calls
        if (
          finishReason === "tool_calls" &&
          toolCallAccumulator.size > 0
        ) {
          // Build the assistant message with tool_calls for session history
          const toolCalls = [...toolCallAccumulator.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));

          session.addMessage({
            role: "assistant",
            content: fullContent,
            tool_calls: toolCalls,
          });

          // Execute each tool call
          for (const toolCall of toolCalls) {
            yield {
              type: "tool_start",
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
            };

            let args: Record<string, unknown>;
            try {
              args = JSON.parse(
                toolCall.function.arguments,
              ) as Record<string, unknown>;
            } catch {
              args = {};
            }

            const result = await this.orchestrator.execute({
              skillId: this.config.skillId,
              toolName: toolCall.function.name,
              args,
            });

            totalToolCalls++;

            const toolContent = result.success
              ? result.output
              : `Error: ${result.error ?? "Unknown error"}`;

            yield {
              type: "tool_result",
              toolCallId: toolCall.id,
              result: toolContent,
              success: result.success,
            };

            session.addMessage({
              role: "tool",
              content: toolContent,
              tool_call_id: toolCall.id,
            });
          }

          rounds++;

          if (rounds >= this.config.maxToolRounds) {
            const errorMessage = `Stopped after ${rounds} tool rounds (max: ${this.config.maxToolRounds}). Last content may be incomplete.`;
            session.addMessage({ role: "assistant", content: errorMessage });
            yield {
              type: "done",
              response: {
                message: errorMessage,
                toolCallsMade: totalToolCalls,
                model: this.config.model,
              },
            };
            return;
          }

          continue;
        }

        // No tool calls -- final response
        session.addMessage({ role: "assistant", content: fullContent });

        yield {
          type: "done",
          response: {
            message: fullContent,
            toolCallsMade: totalToolCalls,
            model: this.config.model,
          },
        };
        return;
      }
    } catch (err: unknown) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
```

**Step 3: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/agent/agent.test.ts`
Expected: All tests PASS (both existing `processMessage` and new `processMessageStream` tests)

**Step 4: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 5: Commit**

```bash
git add packages/core/src/agent/agent.ts
git commit -m "feat(core): implement processMessageStream() async generator"
```

---

## Task 4: Update `OutboundMessage` with optional `stream` field

**Files:**
- Modify: `packages/core/src/channels/types.ts:11-14`

**Step 1: Add `stream` field**

Update the `OutboundMessage` interface:

```typescript
export interface OutboundMessage {
  content: string;
  metadata?: Record<string, unknown> | undefined;
  stream?: boolean | undefined;
}
```

**Step 2: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean (field is optional, so no downstream breakage)

**Step 3: Commit**

```bash
git add packages/core/src/channels/types.ts
git commit -m "feat(core): add optional stream field to OutboundMessage"
```

---

## Task 5: Write failing tests for CLI streaming

**Files:**
- Create: `packages/cli/src/commands/chat.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi } from "vitest";
import { setupStreamingChat } from "./chat.js";
import type { CliAdapter } from "../adapter.js";
import type { Agent, Session, AgentStreamEvent } from "@safeclaw/core";

async function* fakeStream(
  events: AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createChatMocks() {
  const written: string[] = [];

  const adapter = {
    onMessage: vi.fn(),
    onStreamMessage: vi.fn(),
    peer: { channelId: "cli", peerId: "local" },
  } as unknown as CliAdapter;

  const agent = {
    processMessageStream: vi.fn(),
  } as unknown as Agent;

  const session = {} as Session;

  return { adapter, agent, session, written };
}

describe("setupStreamingChat", () => {
  it("registers a stream handler on the adapter", () => {
    const { adapter, agent, session } = createChatMocks();
    setupStreamingChat(adapter, agent, session);
    expect(adapter.onStreamMessage).toHaveBeenCalledWith(expect.any(Function));
  });

  it("handler calls processMessageStream and yields text deltas", async () => {
    const { adapter, agent, session } = createChatMocks();

    const events: AgentStreamEvent[] = [
      { type: "text_delta", content: "Hello" },
      { type: "text_delta", content: " world" },
      {
        type: "done",
        response: {
          message: "Hello world",
          toolCallsMade: 0,
          model: "claude-sonnet-4",
        },
      },
    ];

    vi.mocked(agent.processMessageStream).mockReturnValue(
      fakeStream(events),
    );

    setupStreamingChat(adapter, agent, session);

    // Get the handler that was registered
    const handler = vi.mocked(adapter.onStreamMessage).mock.calls[0]![0] as (
      msg: { peer: { channelId: string; peerId: string }; content: string; timestamp: Date },
    ) => AsyncIterable<{ content: string; stream?: boolean }>;

    const outbound: Array<{ content: string; stream?: boolean }> = [];
    for await (const msg of handler({
      peer: { channelId: "cli", peerId: "local" },
      content: "Hi",
      timestamp: new Date(),
    })) {
      outbound.push(msg);
    }

    expect(outbound).toEqual([
      { content: "Hello", stream: true },
      { content: " world", stream: true },
      { content: "", stream: false },
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/chat.test.ts`
Expected: FAIL -- `setupStreamingChat` is not exported / `onStreamMessage` not a function

**Step 3: Commit**

```bash
git add packages/cli/src/commands/chat.test.ts
git commit -m "test(cli): add failing tests for streaming chat wiring"
```

---

## Task 6: Add `onStreamMessage()` to CLI adapter

**Files:**
- Modify: `packages/cli/src/adapter.ts:1-86`

**Step 1: Add the stream handler field and method**

Add a new private field after line 18:

```typescript
  private streamHandler:
    | ((msg: InboundMessage) => AsyncIterable<OutboundMessage>)
    | null = null;
```

Add the `onStreamMessage()` method after `onMessage()` (after line 55):

```typescript
  onStreamMessage(
    handler: (msg: InboundMessage) => AsyncIterable<OutboundMessage>,
  ): void {
    this.streamHandler = handler;
  }
```

**Step 2: Update `handleLine()` to prefer the stream handler**

Replace the `handleLine()` method (lines 64-85) with:

```typescript
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      this.rl?.prompt();
      return;
    }

    const inbound: InboundMessage = {
      peer: this.peer,
      content: trimmed,
      timestamp: new Date(),
    };

    const stream = this.output as NodeJS.WritableStream & {
      write(s: string): boolean;
    };

    if (this.streamHandler) {
      for await (const chunk of this.streamHandler(inbound)) {
        if (chunk.stream) {
          stream.write(chunk.content);
        } else {
          stream.write("\n");
        }
      }
      this.rl?.prompt();
      return;
    }

    if (!this.handler) {
      this.rl?.prompt();
      return;
    }

    const response = await this.handler(inbound);
    await this.send(this.peer, response);
    this.rl?.prompt();
  }
```

**Step 3: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 4: Commit**

```bash
git add packages/cli/src/adapter.ts
git commit -m "feat(cli): add onStreamMessage() to CliAdapter for streaming output"
```

---

## Task 7: Wire streaming into the chat command

**Files:**
- Modify: `packages/cli/src/commands/chat.ts:1-16`

**Step 1: Add `setupStreamingChat()` function**

Replace the entire file with:

```typescript
import type { Agent, Session, OutboundMessage } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";

/**
 * Wire the CLI adapter to the agent for interactive chat (non-streaming).
 */
export function setupChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
): void {
  adapter.onMessage(async (msg) => {
    const response = await agent.processMessage(session, msg.content);
    return { content: response.message };
  });
}

/**
 * Wire the CLI adapter to the agent for streaming chat.
 * Text deltas are written to the terminal as they arrive.
 */
export function setupStreamingChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
): void {
  adapter.onStreamMessage(async function* (msg) {
    const stream = agent.processMessageStream(session, msg.content);

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          yield { content: event.content, stream: true } satisfies OutboundMessage;
          break;
        case "tool_start":
          // Could emit a status indicator in the future
          break;
        case "tool_result":
          // Could emit tool status in the future
          break;
        case "done":
          // Signal end of stream
          yield { content: "", stream: false } satisfies OutboundMessage;
          break;
        case "error":
          yield { content: `\nError: ${event.error}`, stream: false } satisfies OutboundMessage;
          break;
      }
    }
  });
}
```

**Step 2: Run the chat tests**

Run: `npx vitest run packages/cli/src/commands/chat.test.ts`
Expected: All PASS

**Step 3: Type-check full project**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 4: Commit**

```bash
git add packages/cli/src/commands/chat.ts
git commit -m "feat(cli): wire streaming chat with setupStreamingChat()"
```

---

## Task 8: Run full test suite and lint

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass (both existing and new)

**Step 2: Run linter**

Run: `pnpm lint`
Expected: Clean

**Step 3: Run type-check**

Run: `pnpm typecheck`
Expected: Clean

**Step 4: If any failures, fix them and commit**

```bash
git add -A
git commit -m "fix(core): address test/lint issues from streaming implementation"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Define `AgentStreamEvent` types | `packages/core/src/agent/types.ts`, `packages/core/src/agent/index.ts` |
| 2 | Write failing streaming agent tests | `packages/core/src/agent/agent.test.ts` |
| 3 | Implement `processMessageStream()` | `packages/core/src/agent/agent.ts` |
| 4 | Add `stream` field to `OutboundMessage` | `packages/core/src/channels/types.ts` |
| 5 | Write failing CLI streaming tests | `packages/cli/src/commands/chat.test.ts` |
| 6 | Add `onStreamMessage()` to CLI adapter | `packages/cli/src/adapter.ts` |
| 7 | Wire `setupStreamingChat()` | `packages/cli/src/commands/chat.ts` |
| 8 | Full verification pass | All |

**Not in scope (future work):**
- WebChat adapter streaming (SSE-based)
- Gateway endpoint for streaming (`/api/chat/stream`)
- Tool execution streaming (tools remain synchronous)
- Streaming indicator/spinner UI in CLI
