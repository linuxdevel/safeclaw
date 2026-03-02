import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./types.js";
import type { CopilotClient } from "../copilot/client.js";
import type {
  ChatCompletionResponse,
  ChatMessage,
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
  } as unknown as Session;

  const client = {
    chat: vi.fn(),
  } as unknown as CopilotClient;

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

  return { session, client, orchestrator, toolRegistry, history };
}

// --- tests ---

describe("Agent", () => {
  describe("processMessage", () => {
    it("adds user message to session", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(client.chat).mockResolvedValue(
        makeResponse("Hello there!"),
      );

      const agent = new Agent(makeConfig(), client, orchestrator);
      await agent.processMessage(session, "Hi");

      expect(session.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: "user", content: "Hi" }),
      );
    });

    it("calls copilot client with system prompt and history", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(client.chat).mockResolvedValue(
        makeResponse("Sure thing!"),
      );

      const config = makeConfig({ systemPrompt: "Be helpful." });
      const agent = new Agent(config, client, orchestrator);
      await agent.processMessage(session, "Do something");

      expect(client.chat).toHaveBeenCalledWith(
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
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(client.chat).mockResolvedValue(
        makeResponse("Here is my answer."),
      );

      const agent = new Agent(makeConfig(), client, orchestrator);
      const result = await agent.processMessage(session, "Question?");

      expect(result).toEqual({
        message: "Here is my answer.",
        toolCallsMade: 0,
        model: "claude-sonnet-4",
      });
    });

    it("adds final assistant message to session history", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(client.chat).mockResolvedValue(
        makeResponse("Final answer."),
      );

      const agent = new Agent(makeConfig(), client, orchestrator);
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
      const { session, client, orchestrator, toolRegistry } = createMocks();
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

      vi.mocked(client.chat)
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(finalResponse);

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "127.0.0.1 localhost",
        durationMs: 5,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), client, orchestrator);
      const result = await agent.processMessage(session, "Read the hosts file");

      // Orchestrator should have been called
      expect(orchestrator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "read_file",
          args: { path: "/etc/hosts" },
        }),
      );

      // Client should have been called twice
      expect(client.chat).toHaveBeenCalledTimes(2);

      // Result should be from the final response
      expect(result.message).toBe("The file contains localhost.");
      expect(result.toolCallsMade).toBe(1);
    });

    it("handles multiple tool calls in a single response", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
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

      vi.mocked(client.chat)
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(makeResponse("Done."));

      vi.mocked(orchestrator.execute).mockResolvedValue({
        success: true,
        output: "result",
        durationMs: 1,
        sandboxed: false,
      });

      const agent = new Agent(makeConfig(), client, orchestrator);
      const result = await agent.processMessage(session, "Do both");

      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      // Each tool call in a round counts; the round itself counts as 1
      expect(result.toolCallsMade).toBe(2);
    });

    it("enforces maxToolRounds and stops after limit", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      // Always return tool calls — infinite loop
      vi.mocked(client.chat).mockResolvedValue(
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
      const agent = new Agent(config, client, orchestrator);
      const result = await agent.processMessage(session, "Loop forever");

      // Should have stopped after 3 rounds, not gone infinite
      // client.chat called 3 times: each round calls chat then executes tools
      expect(client.chat).toHaveBeenCalledTimes(3);
      expect(result.message).toContain("tool");
    });

    it("includes tool definitions in chat request", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      const handler = makeToolHandler({
        name: "search",
        description: "Search for text",
      });
      vi.mocked(toolRegistry.list).mockReturnValue([handler]);
      vi.mocked(client.chat).mockResolvedValue(makeResponse("No results."));

      const agent = new Agent(makeConfig(), client, orchestrator);
      await agent.processMessage(session, "Search for foo");

      const chatCall = vi.mocked(client.chat).mock.calls[0]![0];
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
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([makeToolHandler()]);

      vi.mocked(client.chat)
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

      const agent = new Agent(makeConfig(), client, orchestrator);
      await agent.processMessage(session, "Read secret");

      // The tool result message should contain the error
      const addCalls = vi.mocked(session.addMessage).mock.calls;
      const toolMessage = addCalls.find((c) => c[0].role === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage![0].content).toContain("Permission denied");
    });

    it("passes temperature and maxTokens to chat request", async () => {
      const { session, client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);
      vi.mocked(client.chat).mockResolvedValue(makeResponse("Ok."));

      const config = makeConfig({ temperature: 0.5, maxTokens: 1000 });
      const agent = new Agent(config, client, orchestrator);
      await agent.processMessage(session, "Hello");

      const chatCall = vi.mocked(client.chat).mock.calls[0]![0];
      expect(chatCall.temperature).toBe(0.5);
      expect(chatCall.max_tokens).toBe(1000);
    });
  });

  describe("getToolDefinitions", () => {
    it("converts tool handlers to API format", () => {
      const { client, orchestrator, toolRegistry } = createMocks();
      const handler = makeToolHandler({
        name: "write_file",
        description: "Write to a file",
      });
      vi.mocked(toolRegistry.list).mockReturnValue([handler]);

      const agent = new Agent(makeConfig(), client, orchestrator);
      const defs = agent.getToolDefinitions();

      expect(defs).toHaveLength(1);
      expect(defs[0]).toEqual({
        type: "function",
        function: {
          name: "write_file",
          description: "Write to a file",
          parameters: {},
        },
      });
    });

    it("returns empty array when no tools registered", () => {
      const { client, orchestrator, toolRegistry } = createMocks();
      vi.mocked(toolRegistry.list).mockReturnValue([]);

      const agent = new Agent(makeConfig(), client, orchestrator);
      const defs = agent.getToolDefinitions();

      expect(defs).toEqual([]);
    });
  });
});
