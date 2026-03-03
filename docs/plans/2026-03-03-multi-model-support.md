# Multi-Model Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Abstract the LLM client into a `ModelProvider` interface and add support for direct OpenAI and Anthropic API access alongside the existing GitHub Copilot provider.

**Architecture:** Define a `ModelProvider` interface with `chat()` and `chatStream()` methods matching the existing `CopilotClient` shape, using the same OpenAI-compatible request/response types already in `copilot/types.ts`. Wrap `CopilotClient` as `CopilotProvider`, add `OpenAIProvider` (same wire format as Copilot, different auth), and `AnthropicProvider` (translates between OpenAI and Anthropic message formats). A `ProviderRegistry` manages available providers by string ID. `Agent` takes `ModelProvider` instead of `CopilotClient`. Bootstrap selects and instantiates the provider based on vault-stored config and API keys.

**Tech Stack:** TypeScript, Node.js native `fetch`, Vitest

---

## Task 1: Define `ModelProvider` interface

**Files:**
- Create: `packages/core/src/providers/types.ts`
- Create: `packages/core/src/providers/index.ts`
- Modify: `packages/core/src/index.ts:1-8`

**Step 1: Create `packages/core/src/providers/types.ts`**

```typescript
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "../copilot/types.js";

/**
 * Common interface for all LLM providers.
 *
 * The request/response types follow the OpenAI chat-completions wire format
 * which Copilot also uses. Providers that use a different wire format
 * (e.g. Anthropic) translate internally.
 */
export interface ModelProvider {
  /** Unique provider identifier, e.g. "copilot", "openai", "anthropic". */
  readonly id: string;

  /** Send a non-streaming chat completion request. */
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /** Send a streaming chat completion request. Yields parsed SSE chunks. */
  chatStream(request: ChatCompletionRequest): AsyncIterable<StreamChunk>;
}

/** Configuration for the OpenAI provider. */
export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

/** Configuration for the Anthropic provider. */
export interface AnthropicProviderConfig {
  apiKey: string;
}
```

**Step 2: Create `packages/core/src/providers/index.ts`**

```typescript
export type {
  ModelProvider,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
} from "./types.js";
```

**Step 3: Add providers barrel to `packages/core/src/index.ts`**

Add a new line after line 5 (`export * from "./copilot/index.js";`):

```typescript
export * from "./providers/index.js";
```

**Step 4: Verify it type-checks**

Run: `npx tsc --build --dry`
Expected: Clean (no errors)

**Step 5: Commit**

```bash
git add packages/core/src/providers/types.ts packages/core/src/providers/index.ts packages/core/src/index.ts
git commit -m "feat(core): define ModelProvider interface for multi-model support"
```

---

## Task 2: Create `CopilotProvider`

**Files:**
- Create: `packages/core/src/providers/copilot.test.ts`
- Create: `packages/core/src/providers/copilot.ts`
- Modify: `packages/core/src/providers/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/providers/copilot.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { CopilotProvider } from "./copilot.js";
import type { CopilotClient } from "../copilot/client.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "../copilot/types.js";

function makeMockClient(): CopilotClient {
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
  } as unknown as CopilotClient;
}

const baseRequest: ChatCompletionRequest = {
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "Hello" }],
};

const baseResponse: ChatCompletionResponse = {
  id: "resp-1",
  model: "claude-sonnet-4",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe("CopilotProvider", () => {
  it("has id 'copilot'", () => {
    const client = makeMockClient();
    const provider = new CopilotProvider(client);
    expect(provider.id).toBe("copilot");
  });

  it("delegates chat() to CopilotClient", async () => {
    const client = makeMockClient();
    vi.mocked(client.chat).mockResolvedValue(baseResponse);

    const provider = new CopilotProvider(client);
    const result = await provider.chat(baseRequest);

    expect(client.chat).toHaveBeenCalledWith(baseRequest);
    expect(result).toEqual(baseResponse);
  });

  it("delegates chatStream() to CopilotClient", async () => {
    const client = makeMockClient();
    const chunk: StreamChunk = {
      id: "chunk-1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: { content: "Hi" }, finish_reason: null },
      ],
    };

    async function* fakeStream(): AsyncIterable<StreamChunk> {
      yield chunk;
    }

    vi.mocked(client.chatStream).mockReturnValue(fakeStream());

    const provider = new CopilotProvider(client);
    const chunks: StreamChunk[] = [];
    for await (const c of provider.chatStream(baseRequest)) {
      chunks.push(c);
    }

    expect(client.chatStream).toHaveBeenCalledWith(baseRequest);
    expect(chunks).toEqual([chunk]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/providers/copilot.test.ts`
Expected: FAIL — `./copilot.js` does not exist

**Step 3: Write the implementation**

Create `packages/core/src/providers/copilot.ts`:

```typescript
import type { CopilotClient } from "../copilot/client.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "../copilot/types.js";
import type { ModelProvider } from "./types.js";

/**
 * ModelProvider wrapper around the existing CopilotClient.
 *
 * Delegates all calls directly — no format translation needed since
 * the Copilot API uses the same OpenAI-compatible wire format.
 */
export class CopilotProvider implements ModelProvider {
  readonly id = "copilot";

  private readonly client: CopilotClient;

  constructor(client: CopilotClient) {
    this.client = client;
  }

  async chat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return this.client.chat(request);
  }

  async *chatStream(
    request: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    yield* this.client.chatStream(request);
  }
}
```

**Step 4: Re-export from `packages/core/src/providers/index.ts`**

Update to:

```typescript
export type {
  ModelProvider,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
} from "./types.js";
export { CopilotProvider } from "./copilot.js";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/providers/copilot.test.ts`
Expected: 3 tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/providers/copilot.ts packages/core/src/providers/copilot.test.ts packages/core/src/providers/index.ts
git commit -m "feat(core): add CopilotProvider wrapping existing CopilotClient"
```

---

## Task 3: Create `OpenAIProvider`

**Files:**
- Create: `packages/core/src/providers/openai.test.ts`
- Create: `packages/core/src/providers/openai.ts`
- Modify: `packages/core/src/providers/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/providers/openai.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/providers/openai.test.ts`
Expected: FAIL — `./openai.js` does not exist

**Step 3: Write the implementation**

Create `packages/core/src/providers/openai.ts`:

```typescript
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "../copilot/types.js";
import type { ModelProvider, OpenAIProviderConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * ModelProvider for the OpenAI API.
 *
 * The OpenAI chat completions API uses the same wire format as the
 * Copilot API, so no request/response translation is needed.
 * Supports custom base URLs for OpenAI-compatible APIs (Azure, etc.).
 */
export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async chat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this._fetch({ ...request, stream: false });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unable to read body)");
      throw new Error(
        `Chat request failed: ${response.status} ${response.statusText}\n${body}`,
      );
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  async *chatStream(
    request: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const response = await this._fetch({ ...request, stream: true });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unable to read body)");
      throw new Error(
        `Chat stream request failed: ${response.status} ${response.statusText}\n${body}`,
      );
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "" || !trimmed.startsWith("data: ")) {
            continue;
          }

          const payload = trimmed.slice(6);
          if (payload === "[DONE]") {
            return;
          }

          yield JSON.parse(payload) as StreamChunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async _fetch(body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}
```

**Step 4: Re-export from `packages/core/src/providers/index.ts`**

Update to:

```typescript
export type {
  ModelProvider,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
} from "./types.js";
export { CopilotProvider } from "./copilot.js";
export { OpenAIProvider } from "./openai.js";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/providers/openai.test.ts`
Expected: 7 tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/providers/openai.ts packages/core/src/providers/openai.test.ts packages/core/src/providers/index.ts
git commit -m "feat(core): add OpenAI model provider"
```

---

## Task 4: Create `AnthropicProvider`

This provider requires format translation. The Anthropic Messages API uses a different structure:
- System prompt is a top-level `system` field, not a message
- Tool results use `tool_result` content blocks, not `role: "tool"` messages
- Response uses `content` array of typed blocks, not `message.content` string
- Streaming uses different event types (`content_block_delta`, `message_delta`)

**Files:**
- Create: `packages/core/src/providers/anthropic.test.ts`
- Create: `packages/core/src/providers/anthropic.ts`
- Modify: `packages/core/src/providers/index.ts`

**Step 1: Write failing tests for request translation**

Create `packages/core/src/providers/anthropic.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/providers/anthropic.test.ts`
Expected: FAIL — `./anthropic.js` does not exist

**Step 3: Write the implementation**

Create `packages/core/src/providers/anthropic.ts`:

```typescript
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatMessage,
  StreamChunk,
  ToolCall,
  ToolDefinitionParam,
} from "../copilot/types.js";
import type { ModelProvider, AnthropicProviderConfig } from "./types.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

// --- Anthropic API types (internal, not exported) ---

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" };
  temperature?: number;
  stream?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// --- Anthropic SSE event types ---

interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

// --- Provider ---

/**
 * ModelProvider for the Anthropic Messages API.
 *
 * Translates between the OpenAI-compatible request/response types
 * used by the agent and the Anthropic Messages API wire format.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";

  private readonly apiKey: string;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
  }

  async chat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const anthropicRequest = this._translateRequest(request);
    anthropicRequest.stream = false;

    const response = await this._fetch(anthropicRequest);

    if (!response.ok) {
      const body = await response.text().catch(() => "(unable to read body)");
      throw new Error(
        `Chat request failed: ${response.status} ${response.statusText}\n${body}`,
      );
    }

    const anthropicResponse = (await response.json()) as AnthropicResponse;
    return this._translateResponse(anthropicResponse);
  }

  async *chatStream(
    request: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const anthropicRequest = this._translateRequest(request);
    anthropicRequest.stream = true;

    const response = await this._fetch(anthropicRequest);

    if (!response.ok) {
      const body = await response.text().catch(() => "(unable to read body)");
      throw new Error(
        `Chat stream request failed: ${response.status} ${response.statusText}\n${body}`,
      );
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Track state across events to build OpenAI-compatible chunks
    let messageId = "";
    let model = request.model;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "" || trimmed.startsWith("event:")) {
            continue;
          }
          if (!trimmed.startsWith("data: ")) {
            continue;
          }

          const payload = trimmed.slice(6);
          const event = JSON.parse(payload) as AnthropicStreamEvent;

          if (event.type === "message_start") {
            const msg = event.message as { id: string; model: string };
            messageId = msg.id;
            model = msg.model;
            continue;
          }

          if (event.type === "content_block_delta") {
            const delta = event.delta as { type: string; text?: string };
            if (delta.type === "text_delta" && delta.text !== undefined) {
              yield {
                id: messageId,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: delta.text },
                    finish_reason: null,
                  },
                ],
              };
            }
            continue;
          }

          if (event.type === "message_delta") {
            const delta = event.delta as { stop_reason?: string };
            if (delta.stop_reason) {
              yield {
                id: messageId,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason:
                      delta.stop_reason === "end_turn" ? "stop" : "stop",
                  },
                ],
              };
            }
            continue;
          }

          if (event.type === "message_stop") {
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --- Request translation ---

  private _translateRequest(
    request: ChatCompletionRequest,
  ): AnthropicRequest {
    let systemPrompt: string | undefined;
    const messages: AnthropicMessage[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemPrompt = msg.content;
        continue;
      }

      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        // Convert assistant message with tool_calls to Anthropic format
        const content: AnthropicContentBlock[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        messages.push({ role: "assistant", content });
        continue;
      }

      if (msg.role === "tool") {
        // Convert tool result to Anthropic user message with tool_result block
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id!,
              content: msg.content,
            },
          ],
        });
        continue;
      }

      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    const anthropicRequest: AnthropicRequest = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
    };

    if (systemPrompt) {
      anthropicRequest.system = systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = request.tools.map(
        (t: ToolDefinitionParam) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }),
      );
    }

    if (request.tool_choice) {
      anthropicRequest.tool_choice = {
        type: request.tool_choice === "none" ? "none" : "auto",
      };
    }

    if (request.temperature !== undefined) {
      anthropicRequest.temperature = request.temperature;
    }

    return anthropicRequest;
  }

  // --- Response translation ---

  private _translateResponse(
    response: AnthropicResponse,
  ): ChatCompletionResponse {
    // Extract text content
    const textParts = response.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text);
    const content = textParts.join("");

    // Extract tool calls
    const toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use",
    );
    const toolCalls: ToolCall[] = toolUses.map((tu) => ({
      id: tu.id,
      type: "function" as const,
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      },
    }));

    // Map stop_reason
    let finishReason: ChatCompletionChoice["finish_reason"];
    if (response.stop_reason === "tool_use") {
      finishReason = "tool_calls";
    } else if (response.stop_reason === "max_tokens") {
      finishReason = "length";
    } else {
      finishReason = "stop";
    }

    const message: ChatMessage = {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return {
      id: response.id,
      model: response.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens:
          response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  private async _fetch(body: AnthropicRequest): Promise<Response> {
    return fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}
```

**Step 4: Re-export from `packages/core/src/providers/index.ts`**

Update to:

```typescript
export type {
  ModelProvider,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
} from "./types.js";
export { CopilotProvider } from "./copilot.js";
export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/providers/anthropic.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/providers/anthropic.ts packages/core/src/providers/anthropic.test.ts packages/core/src/providers/index.ts
git commit -m "feat(core): add Anthropic model provider with format translation"
```

---

## Task 5: Create `ProviderRegistry`

**Files:**
- Create: `packages/core/src/providers/registry.test.ts`
- Create: `packages/core/src/providers/registry.ts`
- Modify: `packages/core/src/providers/index.ts`

**Step 1: Write the failing test**

Create `packages/core/src/providers/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "./registry.js";
import type { ModelProvider } from "./types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "../copilot/types.js";

function makeMockProvider(id: string): ModelProvider {
  return {
    id,
    chat: vi.fn(),
    chatStream: vi.fn(),
  };
}

describe("ProviderRegistry", () => {
  it("registers and retrieves a provider by id", () => {
    const registry = new ProviderRegistry();
    const provider = makeMockProvider("openai");

    registry.register(provider);

    expect(registry.get("openai")).toBe(provider);
  });

  it("returns undefined for unregistered provider", () => {
    const registry = new ProviderRegistry();

    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered providers", () => {
    const registry = new ProviderRegistry();
    const p1 = makeMockProvider("copilot");
    const p2 = makeMockProvider("openai");
    const p3 = makeMockProvider("anthropic");

    registry.register(p1);
    registry.register(p2);
    registry.register(p3);

    const providers = registry.list();
    expect(providers).toHaveLength(3);
    expect(providers.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "copilot",
      "openai",
    ]);
  });

  it("overwrites provider with same id", () => {
    const registry = new ProviderRegistry();
    const p1 = makeMockProvider("openai");
    const p2 = makeMockProvider("openai");

    registry.register(p1);
    registry.register(p2);

    expect(registry.get("openai")).toBe(p2);
    expect(registry.list()).toHaveLength(1);
  });

  it("returns empty array when no providers registered", () => {
    const registry = new ProviderRegistry();
    expect(registry.list()).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/providers/registry.test.ts`
Expected: FAIL — `./registry.js` does not exist

**Step 3: Write the implementation**

Create `packages/core/src/providers/registry.ts`:

```typescript
import type { ModelProvider } from "./types.js";

/**
 * Registry of available model providers.
 *
 * Stores providers by their string ID and provides lookup/listing.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  /** Register a provider. Overwrites any existing provider with the same id. */
  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Get a provider by id, or undefined if not registered. */
  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  /** List all registered providers. */
  list(): ModelProvider[] {
    return [...this.providers.values()];
  }
}
```

**Step 4: Re-export from `packages/core/src/providers/index.ts`**

Update to:

```typescript
export type {
  ModelProvider,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
} from "./types.js";
export { CopilotProvider } from "./copilot.js";
export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { ProviderRegistry } from "./registry.js";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/providers/registry.test.ts`
Expected: 5 tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/providers/registry.ts packages/core/src/providers/registry.test.ts packages/core/src/providers/index.ts
git commit -m "feat(core): add ProviderRegistry for managing model providers"
```

---

## Task 6: Update `Agent` to accept `ModelProvider`

The `Agent` class currently takes `CopilotClient`. Change it to take `ModelProvider` instead. This is a drop-in replacement since `ModelProvider` has the same `chat()` and `chatStream()` methods.

**Files:**
- Modify: `packages/core/src/agent/agent.ts:1-24`
- Modify: `packages/core/src/agent/agent.test.ts:1-11,59-88`

**Step 1: Update `Agent` constructor and field type**

In `packages/core/src/agent/agent.ts`, replace the import and field:

Replace lines 1-24:

```typescript
import type { ModelProvider } from "../providers/types.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ToolDefinitionParam,
} from "../copilot/types.js";
import type { Session } from "../sessions/session.js";
import type { ToolOrchestrator } from "../tools/orchestrator.js";
import type { AgentConfig, AgentResponse } from "./types.js";

export class Agent {
  private readonly config: AgentConfig;
  private readonly provider: ModelProvider;
  private readonly orchestrator: ToolOrchestrator;

  constructor(
    config: AgentConfig,
    provider: ModelProvider,
    orchestrator: ToolOrchestrator,
  ) {
    this.config = config;
    this.provider = provider;
    this.orchestrator = orchestrator;
  }
```

**Step 2: Update the `chat()` call site**

In `packages/core/src/agent/agent.ts`, replace line 57:

```typescript
      // 3. Call provider.chat()
      const response = await this.provider.chat(request);
```

Replace `this.client.chat(request)` with `this.provider.chat(request)` and update the comment on line 56 from `// 3. Call client.chat()` to `// 3. Call provider.chat()`.

**Step 3: Update the test file**

In `packages/core/src/agent/agent.test.ts`:

Replace lines 1-11 (imports):

```typescript
import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./types.js";
import type { ModelProvider } from "../providers/types.js";
import type {
  ChatCompletionResponse,
  ChatMessage,
} from "../copilot/types.js";
import type { Session } from "../sessions/session.js";
import type { ToolOrchestrator } from "../tools/orchestrator.js";
import type { ToolHandler, ToolRegistry } from "../tools/types.js";
```

In the `createMocks()` function (lines 59-88), replace the `client` mock:

Replace:
```typescript
  const client = {
    chat: vi.fn(),
  } as unknown as CopilotClient;
```

With:
```typescript
  const provider = {
    id: "test",
    chat: vi.fn(),
    chatStream: vi.fn(),
  } as unknown as ModelProvider;
```

And update the return to return `provider` instead of `client`:

Replace:
```typescript
  return { session, client, orchestrator, toolRegistry, history };
```

With:
```typescript
  return { session, provider, orchestrator, toolRegistry, history };
```

**Step 4: Update all test cases to use `provider` instead of `client`**

Throughout the test file, replace all occurrences of:
- `client` variable → `provider`
- `client.chat` → `provider.chat`
- `new Agent(makeConfig(), client, orchestrator)` → `new Agent(makeConfig(), provider, orchestrator)`
- `new Agent(config, client, orchestrator)` → `new Agent(config, provider, orchestrator)`

The full set of replacements (all are mechanical renames):
- Line 95: `const { session, client, orchestrator, toolRegistry } = createMocks();` → use `provider`
- Line 97: `vi.mocked(client.chat)` → `vi.mocked(provider.chat)`
- Line 101: `new Agent(makeConfig(), client, orchestrator)` → `new Agent(makeConfig(), provider, orchestrator)`
- And so on for every test. There are 9 test cases that reference `client`.

**Step 5: Run all agent tests**

Run: `npx vitest run packages/core/src/agent/agent.test.ts`
Expected: All 9 tests PASS

**Step 6: Run full test suite to check nothing breaks**

Run: `npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add packages/core/src/agent/agent.ts packages/core/src/agent/agent.test.ts
git commit -m "refactor(core): agent accepts ModelProvider instead of CopilotClient"
```

---

## Task 7: Update bootstrap to create provider from config

The bootstrap function currently creates a `CopilotClient` directly. Update it to create the appropriate `ModelProvider` based on vault-stored configuration.

**Vault key conventions:**
- `provider` — provider ID string: `"copilot"` (default), `"openai"`, or `"anthropic"`
- `openai_api_key` — OpenAI API key (stored encrypted)
- `openai_base_url` — Optional custom OpenAI-compatible base URL
- `anthropic_api_key` — Anthropic API key (stored encrypted)
- `github_token` — Already exists, used for Copilot provider

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:1-28,120-183`

**Step 1: Update imports in bootstrap**

In `packages/cli/src/commands/bootstrap.ts`, replace lines 8-21:

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
  CopilotProvider,
  OpenAIProvider,
  AnthropicProvider,
} from "@safeclaw/core";
import type { CopilotToken, CopilotModel, ModelProvider } from "@safeclaw/core";
```

**Step 2: Update the agent stack creation in `bootstrapAgent()`**

Replace lines 120-183 (from `// 6. Build Agent stack` to the end of the function body, before `return`) with:

```typescript
  // 6. Build Agent stack
  const model =
    (vault.get("default_model") as CopilotModel | undefined) ??
    DEFAULT_AGENT_CONFIG.model;

  const providerId = vault.get("provider") ?? "copilot";
  const provider = await createProvider(providerId, vault, exchangeToken, githubToken);

  const capabilityRegistry = new CapabilityRegistry();

  // Load and register builtin skill manifest.
  // The builtin manifest ships with the package, so signature verification
  // is intentionally skipped — it is a trusted, first-party artifact.
  let manifestJson: string;
  try {
    manifestJson = readFile(BUILTIN_MANIFEST_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to load builtin skill manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const loader = new SkillLoader();
  const loadResult = loader.loadFromString(manifestJson);
  if (!loadResult.success || !loadResult.manifest) {
    throw new Error(`Failed to load builtin manifest: ${loadResult.error}`);
  }
  const manifest = loadResult.manifest;
  capabilityRegistry.registerSkill(manifest);
  for (const req of manifest.requiredCapabilities) {
    capabilityRegistry.grantCapability({
      skillId: manifest.id,
      capability: req.capability,
      grantedAt: new Date(),
      grantedBy: "builtin",
    });
  }
  const enforcer = new CapabilityEnforcer(capabilityRegistry);

  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools()) {
    toolRegistry.register(tool);
  }

  let sandbox: Sandbox | undefined;
  try {
    sandbox = new Sandbox(DEFAULT_POLICY);
  } catch (err: unknown) {
    // Sandbox not supported on this system — fall back to unsandboxed
    const detail = err instanceof Error ? err.message : String(err);
    output.write(
      `Warning: sandbox not available (${detail}), tools will run unsandboxed\n`,
    );
  }

  const orchestrator = new ToolOrchestrator(
    enforcer,
    toolRegistry,
    sandbox
      ? { sandbox, sandboxedTools: ["bash"] }
      : undefined,
  );
  const agent = new Agent(
    { ...DEFAULT_AGENT_CONFIG, model, skillId: manifest.id },
    provider,
    orchestrator,
  );
  const sessionManager = new SessionManager();
  const auditLog = new AuditLog();

  return { agent, sessionManager, capabilityRegistry, auditLog };
```

**Step 3: Add the `createProvider` helper function**

Add this before the `resolveKey` function (before line 190):

```typescript
async function createProvider(
  providerId: string,
  vault: { get(name: string): string | undefined },
  exchangeToken: (githubToken: string) => Promise<CopilotToken>,
  githubToken: string,
): Promise<ModelProvider> {
  switch (providerId) {
    case "copilot": {
      const copilotToken = await exchangeToken(githubToken);
      const client = new CopilotClient(copilotToken);
      return new CopilotProvider(client);
    }
    case "openai": {
      const apiKey = vault.get("openai_api_key");
      if (!apiKey) {
        throw new Error(
          "No openai_api_key in vault. Run 'safeclaw onboard' to add your OpenAI API key.",
        );
      }
      const baseUrl = vault.get("openai_base_url");
      return new OpenAIProvider({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
    case "anthropic": {
      const apiKey = vault.get("anthropic_api_key");
      if (!apiKey) {
        throw new Error(
          "No anthropic_api_key in vault. Run 'safeclaw onboard' to add your Anthropic API key.",
        );
      }
      return new AnthropicProvider({ apiKey });
    }
    default:
      throw new Error(
        `Unknown provider "${providerId}". Supported: copilot, openai, anthropic`,
      );
  }
}
```

**Step 4: Move copilot token exchange inside `createProvider`**

In the main `bootstrapAgent()` function, the Copilot token exchange at lines 117-118 (`const copilotToken = await exchangeToken(githubToken);`) is no longer needed before provider creation — the `createProvider` helper handles it. Remove those two lines. The `githubToken` is still needed since it's passed to `createProvider`.

**Step 5: Verify it type-checks**

Run: `npx tsc --build --dry`
Expected: Clean (no errors)

**Step 6: Run existing bootstrap tests**

Run: `npx vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: All existing tests PASS (mocks already provide the `chat` method on the client)

Note: Existing bootstrap tests mock `openVault` and `getCopilotToken`, so they still test the `copilot` provider path (the default). The mock vault doesn't return a `provider` key, so `providerId` defaults to `"copilot"`.

**Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add packages/cli/src/commands/bootstrap.ts
git commit -m "feat(cli): bootstrap selects model provider from vault config"
```

---

## Task 8: Store API keys in vault during onboarding

The onboarding command should optionally collect OpenAI and Anthropic API keys and store them in the vault.

**Files:**
- Modify: `packages/cli/src/commands/onboard.ts` (add optional prompts after GitHub token)

**Step 1: Read the existing onboard command**

Read `packages/cli/src/commands/onboard.ts` to understand the current flow.

**Step 2: Add optional provider selection**

After the GitHub token is stored and before `vault.save()`, add prompts:

```typescript
// Optional: configure alternative model provider
output.write("\n--- Optional: Configure additional model providers ---\n");
output.write("Press Enter to skip any provider you don't want to configure.\n\n");

// OpenAI
const openaiKey = await readPass(
  "OpenAI API key (Enter to skip): ",
  input,
  output,
);
if (openaiKey.trim()) {
  vault.set("openai_api_key", openaiKey.trim());
  output.write("OpenAI API key stored.\n");
}

// Anthropic
const anthropicKey = await readPass(
  "Anthropic API key (Enter to skip): ",
  input,
  output,
);
if (anthropicKey.trim()) {
  vault.set("anthropic_api_key", anthropicKey.trim());
  output.write("Anthropic API key stored.\n");
}

// Provider selection
if (openaiKey.trim() || anthropicKey.trim()) {
  const providers = ["copilot"];
  if (openaiKey.trim()) providers.push("openai");
  if (anthropicKey.trim()) providers.push("anthropic");
  output.write(`\nAvailable providers: ${providers.join(", ")}\n`);

  const selectedProvider = await readPass(
    `Default provider [copilot]: `,
    input,
    output,
  );
  const trimmed = selectedProvider.trim();
  if (trimmed && providers.includes(trimmed)) {
    vault.set("provider", trimmed);
    output.write(`Default provider set to: ${trimmed}\n`);
  } else if (trimmed) {
    output.write(`Unknown provider "${trimmed}", keeping default (copilot).\n`);
  }
}
```

Note: The exact insertion point depends on the current onboard.ts structure. Read the file first before editing. API keys are stored encrypted in the vault (vault.set encrypts automatically with AES-256-GCM).

**Step 3: Verify it type-checks**

Run: `npx tsc --build --dry`
Expected: Clean (no errors)

**Step 4: Commit**

```bash
git add packages/cli/src/commands/onboard.ts
git commit -m "feat(cli): optionally collect OpenAI/Anthropic keys during onboarding"
```

---

## Task 9: Run full test suite and verify

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Run type checker**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 3: Run linter**

Run: `npx oxlint`
Expected: Clean (or only pre-existing warnings)

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(core): address lint/type issues from multi-model support"
```

---

## Summary

| Task | Description | Files | Tests |
|------|-------------|-------|-------|
| 1 | Define `ModelProvider` interface | 3 create/modify | Type-check only |
| 2 | `CopilotProvider` (wraps existing client) | 2 create, 1 modify | 3 tests |
| 3 | `OpenAIProvider` (native fetch) | 2 create, 1 modify | 7 tests |
| 4 | `AnthropicProvider` (format translation) | 2 create, 1 modify | ~10 tests |
| 5 | `ProviderRegistry` | 2 create, 1 modify | 5 tests |
| 6 | Update `Agent` to use `ModelProvider` | 2 modify | Existing 9 tests pass |
| 7 | Update bootstrap for provider selection | 1 modify | Existing tests pass |
| 8 | Store API keys in vault during onboarding | 1 modify | Manual verification |
| 9 | Full verification | 0 | Full suite |

**No new npm dependencies.** All HTTP calls use Node.js native `fetch`. API keys stored in AES-256-GCM encrypted vault with 0o600 file permissions.
