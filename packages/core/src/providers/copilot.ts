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
