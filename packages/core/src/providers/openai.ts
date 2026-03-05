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
