import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./types.js";
import type { ContextCompactor } from "./compactor.js";
import type { ModelProvider } from "../providers/types.js";
import type {
  ChatCompletionResponse,
  ChatMessage,
  StreamChunk,
} from "../copilot/types.js";
import type { Session } from "../sessions/session.js";
import type { ToolOrchestrator } from "../tools/orchestrator.js";
import type { ToolHandler, ToolRegistry } from "../tools/types.js";

// --- helpers ---

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "claude-sonnet-4",
    systemPrompt: "You are a test assistant.",
    maxToolRounds: 10,
    skillId: "builtin",
    temperature: undefined,
    maxTokens: undefined,
    ...overrides,
  };
}

function makeResponse(
  content: string,
  toolCalls?: ChatMessage["tool_calls"],
): ChatCompletionResponse {
  return {
    id: "resp-1",
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls,
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeToolHandler(overrides: Partial<ToolHandler> = {}): ToolHandler {
  return {
    name: "read_file",
    description: "Read a file from disk",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs:read"],
    execute: async (_args: Record<string, unknown>) => "file-content",
    ...overrides,
  };
}

function createMocks() {
  const history: ChatMessage[] = [];

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

  const provider = {
    id: "test",
    chat: vi.fn(),
    chatStream: vi.fn(),
  } as unknown as ModelProvider;

  const toolRegistry = {
    list: vi.fn(() => [] as ToolHandler[]),
    get: vi.fn(),
    register: vi.fn(),
  } as unknown as ToolRegistry;

  const orchestrator = {
    execute: vi.fn(),
  } as unknown as ToolOrchestrator;

  // Expose the private field through a cast
  (orchestrator as unknown as { toolRegistry: ToolRegistry }).toolRegistry =
    toolRegistry;

  return { session, provider, orchestrator, toolRegistry, history };
}

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

// --- tests ---

describe("Agent", () => {
  describe("processMessage", () => {
    it("adds user message to session", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(provider.chat).mockResolvedValue(
        makeResponse("Hello there!"),
      );

      const agent = new Agent(makeConfig(), provider, orchestrator);
      await agent.processMessage(session, "Hi");

      expect(session.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: "user", content: "Hi" }),
      );
    });

    it("calls copilot client with system prompt and history", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(provider.chat).mockResolvedValue(
        makeResponse("Sure thing!"),
      );

      const config = makeConfig({ systemPrompt: "Be helpful." });
      const agent = new Agent(config, provider, orchestrator);
      await agent.processMessage(session, "Do something");

      expect(provider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-sonnet-4",
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: "Be helpful.",
            }),
          ]),
        }),
      );
    });

    it("returns assistant response with message and metadata", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(provider.chat).mockResolvedValue(
        makeResponse("Here is my answer."),
      );

      const agent = new Agent(makeConfig(), provider, orchestrator);
      const result = await agent.processMessage(session, "Question?");

      expect(result).toEqual({
        message: "Here is my answer.",
        toolCallsMade: 0,
        model: "claude-sonnet-4",
      });
    });

    it("adds final assistant message to session history", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(provider.chat).mockResolvedValue(
        makeResponse("Final answer."),
      );

      const agent = new Agent(makeConfig(), provider, orchestrator);
      await agent.processMessage(session, "Tell me");

      // First call: user message, Second call: assistant message
      const calls = vi.mocked(session.addMessage).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      expect(lastCall![0]).toEqual(
        expect.objectContaining({
          role: "assistant",
          content: "Final answer.",
        }),
      );
    });

    it("handles tool calls: executes tool, adds result, calls LLM again", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      const handler = makeToolHandler();
      vi.mocked(toolRegistry.list).mockReturnValue([handler]);

      // First response: tool call
      const toolCallResponse = makeResponse("", [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "/etc/hosts" }),
          },
        },
      ]);

      // Second response: final answer
      const finalResponse = makeResponse("The file contains localhost.");

      vi.mocked(provider.chat)
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(finalResponse);

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "127.0.0.1 localhost",
        durationMs: 5,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), provider, orchestrator);
      const result = await agent.processMessage(session, "Read the hosts file");

      // Orchestrator should have been called
      expect(orchestrator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "read_file",
          args: { path: "/etc/hosts" },
        }),
      );

      // Client should have been called twice
      expect(provider.chat).toHaveBeenCalledTimes(2);

      // Result should be from the final response
      expect(result.message).toBe("The file contains localhost.");
      expect(result.toolCallsMade).toBe(1);
    });

    it("handles multiple tool calls in a single response", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([
        makeToolHandler({ name: "read_file" }),
        makeToolHandler({ name: "list_dir" }),
      ]);

      const toolCallResponse = makeResponse("", [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "/a" }),
          },
        },
        {
          id: "call_2",
          type: "function",
          function: {
            name: "list_dir",
            arguments: JSON.stringify({ path: "/b" }),
          },
        },
      ]);

      vi.mocked(provider.chat)
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(makeResponse("Done."));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "result",
        durationMs: 1,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), provider, orchestrator);
      const result = await agent.processMessage(session, "Do both");

      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      // Each tool call in a round counts; the round itself counts as 1
      expect(result.toolCallsMade).toBe(2);
    });

    it("enforces maxToolRounds and stops after limit", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      // Always return tool calls — infinite loop
      vi.mocked(provider.chat).mockResolvedValue(
        makeResponse("thinking...", [
          {
            id: "call_loop",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "/" }),
            },
          },
        ]),
      );

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "ok",
        durationMs: 1,
        sandboxed: false,
      });

      const config = makeConfig({ maxToolRounds: 3 });
      const agent = new Agent(config, provider, orchestrator);
      const result = await agent.processMessage(session, "Loop forever");

      // Should have stopped after 3 rounds, not gone infinite
      // client.chat called 3 times: each round calls chat then executes tools
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(result.message).toContain("tool");
    });

    it("includes tool definitions in chat request", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      const handler = makeToolHandler({
        name: "search",
        description: "Search for text",
      });
      vi.mocked(toolRegistry.list).mockReturnValue([handler]);
      vi.mocked(provider.chat).mockResolvedValue(makeResponse("No results."));

      const agent = new Agent(makeConfig(), provider, orchestrator);
      await agent.processMessage(session, "Search for foo");

      const chatCall = vi.mocked(provider.chat).mock.calls[0]![0];
      expect(chatCall.tools).toBeDefined();
      expect(chatCall.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({
              name: "search",
              description: "Search for text",
            }),
          }),
        ]),
      );
    });

    it("passes failed tool result as error message", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      vi.mocked(provider.chat)
        .mockResolvedValueOnce(
          makeResponse("", [
            {
              id: "call_fail",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "/secret" }),
              },
            },
          ]),
        )
        .mockResolvedValueOnce(makeResponse("Access denied."));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: false,
        output: "",
        error: "Permission denied",
        durationMs: 1,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), provider, orchestrator);
      await agent.processMessage(session, "Read secret");

      // The tool result message should contain the error
      const addCalls = vi.mocked(session.addMessage).mock.calls;
      const toolMessage = addCalls.find((c) => c[0].role === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage![0].content).toContain("Permission denied");
    });

    it("uses configured skillId for tool execution requests", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      vi.mocked(provider.chat)
        .mockResolvedValueOnce(
          makeResponse("", [
            {
              id: "call_skill",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "/tmp/test" }),
              },
            },
          ]),
        )
        .mockResolvedValueOnce(makeResponse("Done."));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "content",
        durationMs: 2,
        sandboxed: false,
      });

      const config = makeConfig({ skillId: "my-custom-skill" });
      const agent = new Agent(config, provider, orchestrator);
      await agent.processMessage(session, "Read a file");

      expect(orchestrator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: "my-custom-skill",
          toolName: "read_file",
          args: { path: "/tmp/test" },
        }),
      );
    });

    it("passes temperature and maxTokens to chat request", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(provider.chat).mockResolvedValue(makeResponse("Ok."));

      const config = makeConfig({ temperature: 0.5, maxTokens: 1000 });
      const agent = new Agent(config, provider, orchestrator);
      await agent.processMessage(session, "Hello");

      const chatCall = vi.mocked(provider.chat).mock.calls[0]![0];
      expect(chatCall.temperature).toBe(0.5);
      expect(chatCall.max_tokens).toBe(1000);
    });
  });

  describe("processMessageStream", () => {
    it("yields text_delta events for each content chunk", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      const chunks = makeStreamChunks("Hi!");
      vi.mocked(provider.chatStream).mockReturnValue(
        asyncIterableFrom(chunks),
      );

      const agent = new Agent(makeConfig(), provider, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Hello"),
      );

      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas).toHaveLength(3); // "H", "i", "!"
      expect(textDeltas.map((e) => (e as { content: string }).content).join("")).toBe("Hi!");
    });

    it("emits done event with complete AgentResponse", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      const chunks = makeStreamChunks("Done.");
      vi.mocked(provider.chatStream).mockReturnValue(
        asyncIterableFrom(chunks),
      );

      const agent = new Agent(makeConfig(), provider, orchestrator);
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
      const { session, provider, orchestrator, toolRegistry } = createMocks();
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

      vi.mocked(provider.chatStream)
        .mockReturnValueOnce(asyncIterableFrom(toolChunks))
        .mockReturnValueOnce(asyncIterableFrom(textChunks));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "127.0.0.1 localhost",
        durationMs: 5,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), provider, orchestrator);
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
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      const toolChunks = makeToolCallStreamChunks([
        {
          id: "call_loop",
          name: "read_file",
          arguments: JSON.stringify({ path: "/" }),
        },
      ]);

      // Always return tool calls
      vi.mocked(provider.chatStream).mockReturnValue(
        asyncIterableFrom(toolChunks),
      );

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "ok",
        durationMs: 1,
        sandboxed: false,
      });

      const config = makeConfig({ maxToolRounds: 1 });
      const agent = new Agent(config, provider, orchestrator);
      const events = await collectEvents(
        agent.processMessageStream(session, "Loop"),
      );

      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents).toHaveLength(1);
      const done = doneEvents[0] as { type: "done"; response: { message: string; toolCallsMade: number } };
      expect(done.response.message).toContain("tool");
      expect(provider.chatStream).toHaveBeenCalledTimes(1);
    });

    it("emits error event on stream failure", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      // eslint-disable-next-line require-yield
      async function* failingStream(): AsyncIterable<StreamChunk> {
        throw new Error("Network error");
      }

      vi.mocked(provider.chatStream).mockReturnValue(failingStream());

      const agent = new Agent(makeConfig(), provider, orchestrator);
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
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      const toolChunks = makeToolCallStreamChunks([
        {
          id: "call_fail",
          name: "read_file",
          arguments: JSON.stringify({ path: "/secret" }),
        },
      ]);
      const textChunks = makeStreamChunks("Access denied.");

      vi.mocked(provider.chatStream)
        .mockReturnValueOnce(asyncIterableFrom(toolChunks))
        .mockReturnValueOnce(asyncIterableFrom(textChunks));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: false,
        output: "",
        error: "Permission denied",
        durationMs: 1,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), provider, orchestrator);
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

  describe("getToolDefinitions", () => {
    it("converts tool handlers to API format", () => {
      const { provider, orchestrator, toolRegistry } = createMocks();
      const handler = makeToolHandler({
        name: "write_file",
        description: "Write to a file",
      });
      vi.mocked(toolRegistry.list).mockReturnValue([handler]);

      const agent = new Agent(makeConfig(), provider, orchestrator);
      const defs = agent.getToolDefinitions();

      expect(defs).toHaveLength(1);
      expect(defs[0]).toEqual({
        type: "function",
        function: {
          name: "write_file",
          description: "Write to a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      });
    });

    it("returns empty array when no tools registered", () => {
      const { provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      const agent = new Agent(makeConfig(), provider, orchestrator);
      const defs = agent.getToolDefinitions();

      expect(defs).toEqual([]);
    });
  });

  describe("context compaction", () => {
    it("compacts session history when prompt_tokens exceeds threshold", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      // Return high token usage that triggers compaction
      vi.mocked(provider.chat).mockResolvedValue({
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

      const agent = new Agent(makeConfig(), provider, orchestrator, compactor);
      await agent.processMessage(session, "Hello");

      expect(compactor.shouldCompact).toHaveBeenCalledWith(85000);
      expect(compactor.compact).toHaveBeenCalled();
    });

    it("does not compact when prompt_tokens is below threshold", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      vi.mocked(provider.chat).mockResolvedValue(
        makeResponse("Hello there!"),
      );

      const compactor = {
        shouldCompact: vi.fn().mockReturnValue(false),
        compact: vi.fn(),
      } as unknown as ContextCompactor;

      const agent = new Agent(makeConfig(), provider, orchestrator, compactor);
      await agent.processMessage(session, "Hi");

      expect(compactor.shouldCompact).toHaveBeenCalledWith(10); // from makeResponse usage
      expect(compactor.compact).not.toHaveBeenCalled();
    });

    it("works without a compactor (backward compatible)", async () => {
      const { session, provider, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(provider.chat).mockResolvedValue(makeResponse("Hello!"));

      // No compactor passed — should work fine
      const agent = new Agent(makeConfig(), provider, orchestrator);
      const result = await agent.processMessage(session, "Hi");

      expect(result.message).toBe("Hello!");
    });
  });
});
