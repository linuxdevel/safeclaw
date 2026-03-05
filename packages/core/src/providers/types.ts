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
