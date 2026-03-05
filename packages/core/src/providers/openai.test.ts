import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "./openai.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "../copilot/types.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseRequest: ChatCompletionRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
};

const baseResponse: ChatCompletionResponse = {
  id: "chatcmpl-abc",
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
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

describe("OpenAIProvider", () => {
  it("has id 'openai'", () => {
    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    expect(provider.id).toBe("openai");
  });

  it("sends chat request to OpenAI API with Bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(baseResponse));

    const provider = new OpenAIProvider({ apiKey: "sk-test-key" });
    const result = await provider.chat(baseRequest);

    expect(result).toEqual(baseResponse);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses custom baseUrl when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(baseResponse));

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://custom.openai.example.com/v1",
    });
    await provider.chat(baseRequest);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://custom.openai.example.com/v1/chat/completions",
    );
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(baseResponse));

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://custom.example.com/v1/",
    });
    await provider.chat(baseRequest);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.example.com/v1/chat/completions");
  });

  it("forces stream: false on chat()", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(baseResponse));

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.chat({ ...baseRequest, stream: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(false);
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid API key" } }, 401),
    );

    const provider = new OpenAIProvider({ apiKey: "bad-key" });
    await expect(provider.chat(baseRequest)).rejects.toThrow(
      /Chat request failed: 401/,
    );
  });

  it("streams SSE chunks from chatStream()", async () => {
    const chunk: StreamChunk = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [
        { index: 0, delta: { content: "Hello" }, finish_reason: null },
      ],
    };

    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify(chunk)}`,
        "data: [DONE]",
      ]),
    );

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const chunks: StreamChunk[] = [];
    for await (const c of provider.chatStream(baseRequest)) {
      chunks.push(c);
    }

    expect(chunks).toEqual([chunk]);
  });
});
