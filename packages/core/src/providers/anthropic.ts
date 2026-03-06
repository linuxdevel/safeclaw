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
      signal: AbortSignal.timeout(AnthropicProvider.REQUEST_TIMEOUT_MS),
    });
  }

  /** Default timeout for all API requests (ms). */
  static readonly REQUEST_TIMEOUT_MS = 60_000;
}
