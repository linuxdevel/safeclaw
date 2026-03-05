import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import type { StreamChunk } from "../copilot/types.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Helpers ---

/** Minimal Anthropic Messages API response shape. */
interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
  >;
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function anthropicJsonResponse(
  data: AnthropicResponse,
  status = 200,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

function anthropicSseResponse(chunks: string[]): Response {
  const lines = chunks.join("\n") + "\n";
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lines);

  let consumed = false;
  const body = {
    getReader() {
      return {
        read() {
          if (consumed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          consumed = true;
          return Promise.resolve({ done: false, value: encoded });
        },
        releaseLock() {
          // no-op
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body,
  } as Response;
}

// --- Tests ---

describe("AnthropicProvider", () => {
  it("has id 'anthropic'", () => {
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
    expect(provider.id).toBe("anthropic");
  });

  describe("chat()", () => {
    it("translates request: extracts system prompt from messages", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Hi!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.system).toBe("You are helpful.");
      // System message should NOT appear in the messages array
      const msgs = body.messages as Array<{ role: string }>;
      expect(msgs.every((m) => m.role !== "system")).toBe(true);
    });

    it("sends correct auth headers", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Hi!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-key123" });
      await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-key123");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("translates text response to OpenAI format", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Hello there!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      const result = await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result).toEqual({
        id: "msg_abc",
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello there!" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });
    });

    it("translates tool_use response to OpenAI format", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_tools",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "text", text: "Let me read that file." },
          {
            type: "tool_use",
            id: "toolu_123",
            name: "read_file",
            input: { path: "/etc/hosts" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 15 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      const result = await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Read /etc/hosts" }],
      });

      expect(result.choices[0]!.finish_reason).toBe("tool_calls");
      expect(result.choices[0]!.message.content).toBe(
        "Let me read that file.",
      );
      expect(result.choices[0]!.message.tool_calls).toEqual([
        {
          id: "toolu_123",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "/etc/hosts" }),
          },
        },
      ]);
    });

    it("translates tool_choice to Anthropic format", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_tc",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
        tool_choice: "auto",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.tool_choice).toEqual({ type: "auto" });
    });

    it("translates tool result messages to Anthropic format", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_tr",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "The file contains localhost." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 10 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: "Read file" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "toolu_123",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "/etc/hosts" }),
                },
              },
            ],
          },
          {
            role: "tool",
            content: "127.0.0.1 localhost",
            tool_call_id: "toolu_123",
          },
        ],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        messages: Array<Record<string, unknown>>;
      };

      // The assistant message should have tool_use content blocks
      const assistantMsg = body.messages.find(
        (m) => m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
      const assistantContent = assistantMsg!.content as Array<{
        type: string;
      }>;
      expect(assistantContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_use",
            id: "toolu_123",
            name: "read_file",
          }),
        ]),
      );

      // The tool message should become a user message with tool_result block
      const toolMsg = body.messages.find((m) => m.role === "user" && Array.isArray(m.content));
      expect(toolMsg).toBeDefined();
      const toolContent = toolMsg!.content as Array<{ type: string }>;
      expect(toolContent).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: "127.0.0.1 localhost",
        }),
      ]);
    });

    it("translates tools to Anthropic format", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_t",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "No results" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 15, output_tokens: 5 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Search" }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Search for text",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          },
        ],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        tools: Array<Record<string, unknown>>;
      };
      expect(body.tools).toEqual([
        {
          name: "search",
          description: "Search for text",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ]);
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("Invalid API key"),
      } as Response);

      const provider = new AnthropicProvider({ apiKey: "bad-key" });
      await expect(
        provider.chat({
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow(/Chat request failed: 401/);
    });

    it("passes max_tokens as max_tokens in Anthropic request", async () => {
      const anthropicResp: AnthropicResponse = {
        id: "msg_mt",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      };
      fetchMock.mockResolvedValueOnce(
        anthropicJsonResponse(anthropicResp),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 2048,
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.max_tokens).toBe(2048);
    });
  });

  describe("chatStream()", () => {
    it("translates Anthropic SSE events to OpenAI StreamChunk format", async () => {
      fetchMock.mockResolvedValueOnce(
        anthropicSseResponse([
          'event: message_start',
          `data: {"type":"message_start","message":{"id":"msg_s1","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`,
          '',
          'event: content_block_start',
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
          '',
          'event: content_block_delta',
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
          '',
          'event: content_block_delta',
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}`,
          '',
          'event: content_block_stop',
          `data: {"type":"content_block_stop","index":0}`,
          '',
          'event: message_delta',
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
          '',
          'event: message_stop',
          `data: {"type":"message_stop"}`,
        ]),
      );

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      const chunks: StreamChunk[] = [];
      for await (const c of provider.chatStream({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
      })) {
        chunks.push(c);
      }

      // Should get text delta chunks
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]!.choices[0]!.delta.content).toBe("Hello");
      expect(chunks[1]!.choices[0]!.delta.content).toBe(" world");

      // Last chunk with finish_reason
      const lastChunk = chunks[chunks.length - 1]!;
      expect(lastChunk.choices[0]!.finish_reason).toBe("stop");
    });
  });
});
