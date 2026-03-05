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
