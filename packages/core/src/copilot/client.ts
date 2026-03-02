import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  CopilotToken,
  StreamChunk,
} from "./types.js";
import { COPILOT_API_BASE } from "./types.js";

export class CopilotClient {
  private readonly _token: CopilotToken;

  constructor(token: CopilotToken) {
    this._token = token;
  }

  /**
   * Send a non-streaming chat completion request.
   */
  async chat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this._fetch("/chat/completions", {
      ...request,
      stream: false,
    });

    if (!response.ok) {
      throw new Error(
        `Chat request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  /**
   * Send a streaming chat completion request. Yields parsed SSE chunks.
   */
  async *chatStream(
    request: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const response = await this._fetch("/chat/completions", {
      ...request,
      stream: true,
    });

    if (!response.ok) {
      throw new Error(
        `Chat stream request failed: ${response.status} ${response.statusText}`,
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
        // Keep the last incomplete line in the buffer
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

  private async _fetch(path: string, body: unknown): Promise<Response> {
    return fetch(`${COPILOT_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._token.token}`,
        "Copilot-Integration-Id": "safeclaw",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}
