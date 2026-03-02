import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CopilotClient } from "./client.js";
import { COPILOT_API_BASE } from "./types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  CopilotToken,
  StreamChunk,
} from "./types.js";

const token: CopilotToken = {
  token: "test-copilot-token",
  expiresAt: Date.now() + 3600_000,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseRequest: ChatCompletionRequest = {
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "Hello" }],
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  } as Response;
}

function sseResponse(chunks: string[]): Response {
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

describe("CopilotClient", () => {
  describe("chat", () => {
    it("sends correct request and parses response", async () => {
      const completionResponse: ChatCompletionResponse = {
        id: "chatcmpl-123",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hi there!" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(completionResponse));

      const client = new CopilotClient(token);
      const result = await client.chat(baseRequest);

      expect(result).toEqual(completionResponse);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("includes auth headers", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "x",
          model: "claude-sonnet-4",
          choices: [],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }),
      );

      const client = new CopilotClient(token);
      await client.chat(baseRequest);

      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe(`${COPILOT_API_BASE}/chat/completions`);
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(
        `Bearer ${token.token}`,
      );
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
      expect(headers["Editor-Version"]).toMatch(/^SafeClaw\//);
      expect(headers["Editor-Plugin-Version"]).toMatch(/^SafeClaw\//);
      expect(headers["User-Agent"]).toMatch(/^safeclaw\//);
    });

    it("throws on non-ok response with body", async () => {
      const errorBody = '{"error":"invalid_model","message":"Model not found"}';
      const errorResponse = {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve(errorBody),
      } as Response;
      fetchMock.mockResolvedValue(errorResponse);

      const client = new CopilotClient(token);
      const err = (await client
        .chat(baseRequest)
        .catch((e: Error) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("Chat request failed: 400 Bad Request");
      expect(err.message).toContain("invalid_model");
    });
  });

  describe("chatStream", () => {
    it("yields parsed SSE chunks", async () => {
      const chunk1: StreamChunk = {
        id: "chatcmpl-1",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello" },
            finish_reason: null,
          },
        ],
      };
      const chunk2: StreamChunk = {
        id: "chatcmpl-1",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: " world" },
            finish_reason: null,
          },
        ],
      };

      fetchMock.mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify(chunk1)}`,
          `data: ${JSON.stringify(chunk2)}`,
          "data: [DONE]",
        ]),
      );

      const client = new CopilotClient(token);
      const chunks: StreamChunk[] = [];
      for await (const c of client.chatStream(baseRequest)) {
        chunks.push(c);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual(chunk1);
      expect(chunks[1]).toEqual(chunk2);
    });

    it("handles [DONE] sentinel", async () => {
      const chunk: StreamChunk = {
        id: "chatcmpl-1",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: "Hi" },
            finish_reason: null,
          },
        ],
      };

      fetchMock.mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify(chunk)}`,
          "data: [DONE]",
          // This chunk should never be reached
          `data: ${JSON.stringify({ ...chunk, id: "should-not-appear" })}`,
        ]),
      );

      const client = new CopilotClient(token);
      const chunks: StreamChunk[] = [];
      for await (const c of client.chatStream(baseRequest)) {
        chunks.push(c);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(chunk);
    });

    it("skips empty lines", async () => {
      const chunk: StreamChunk = {
        id: "chatcmpl-1",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: "test" },
            finish_reason: null,
          },
        ],
      };

      fetchMock.mockResolvedValueOnce(
        sseResponse([
          "",
          `data: ${JSON.stringify(chunk)}`,
          "",
          "",
          "data: [DONE]",
        ]),
      );

      const client = new CopilotClient(token);
      const chunks: StreamChunk[] = [];
      for await (const c of client.chatStream(baseRequest)) {
        chunks.push(c);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(chunk);
    });
  });
});
