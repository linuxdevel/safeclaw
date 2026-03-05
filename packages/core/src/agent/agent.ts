import type { CopilotClient } from "../copilot/client.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ToolDefinitionParam,
} from "../copilot/types.js";
import type { Session } from "../sessions/session.js";
import type { ToolOrchestrator } from "../tools/orchestrator.js";
import type { ContextCompactor } from "./compactor.js";
import type { AgentConfig, AgentResponse, AgentStreamEvent } from "./types.js";

export class Agent {
  private readonly config: AgentConfig;
  private readonly client: CopilotClient;
  private readonly orchestrator: ToolOrchestrator;
  private readonly compactor?: ContextCompactor | undefined;

  constructor(
    config: AgentConfig,
    client: CopilotClient,
    orchestrator: ToolOrchestrator,
    compactor?: ContextCompactor,
  ) {
    this.config = config;
    this.client = client;
    this.orchestrator = orchestrator;
    this.compactor = compactor;
  }

  async processMessage(
    session: Session,
    userMessage: string,
  ): Promise<AgentResponse> {
    // 1. Add user message to session
    session.addMessage({ role: "user", content: userMessage });

    let totalToolCalls = 0;
    let rounds = 0;

    for (;;) {
      // 2. Build request: system prompt + session history
      const messages: ChatMessage[] = [
        { role: "system", content: this.config.systemPrompt },
        ...session.getHistory(),
      ];

      const tools = this.getToolDefinitions();
      const request: ChatCompletionRequest = {
        model: this.config.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        ...(this.config.temperature !== undefined
          ? { temperature: this.config.temperature }
          : {}),
        ...(this.config.maxTokens !== undefined
          ? { max_tokens: this.config.maxTokens }
          : {}),
      };

      // 3. Call client.chat()
      const response = await this.client.chat(request);

      // Check if context compaction is needed
      if (this.compactor && this.compactor.shouldCompact(response.usage.prompt_tokens)) {
        const compacted = await this.compactor.compact(session.getHistory());
        session.setHistory(compacted);
      }

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("No choices in chat completion response");
      }

      const assistantMessage = choice.message;

      // 4. If response has tool_calls: execute each via orchestrator
      if (
        choice.finish_reason === "tool_calls" &&
        assistantMessage.tool_calls &&
        assistantMessage.tool_calls.length > 0
      ) {
        // Add assistant message with tool_calls to session
        session.addMessage(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(
              toolCall.function.arguments,
            ) as Record<string, unknown>;
          } catch {
            args = {};
          }

          const result = await this.orchestrator.execute({
            skillId: this.config.skillId,
            toolName: toolCall.function.name,
            args,
          });

          totalToolCalls++;

          // Add tool result message to session
          const toolContent = result.success
            ? result.output
            : `Error: ${result.error ?? "Unknown error"}`;

          session.addMessage({
            role: "tool",
            content: toolContent,
            tool_call_id: toolCall.id,
          });
        }

        rounds++;

        // 5. Enforce maxToolRounds
        if (rounds >= this.config.maxToolRounds) {
          const errorMessage = `Stopped after ${rounds} tool rounds (max: ${this.config.maxToolRounds}). Last content may be incomplete.`;
          session.addMessage({ role: "assistant", content: errorMessage });
          return {
            message: errorMessage,
            toolCallsMade: totalToolCalls,
            model: this.config.model,
          };
        }

        continue;
      }

      // 6. No tool calls — this is the final response
      const finalContent = assistantMessage.content || "";
      session.addMessage({ role: "assistant", content: finalContent });

      return {
        message: finalContent,
        toolCallsMade: totalToolCalls,
        model: this.config.model,
      };
    }
  }

  async *processMessageStream(
    session: Session,
    userMessage: string,
  ): AsyncGenerator<AgentStreamEvent> {
    session.addMessage({ role: "user", content: userMessage });

    let totalToolCalls = 0;
    let rounds = 0;

    try {
      for (;;) {
        const messages: ChatMessage[] = [
          { role: "system", content: this.config.systemPrompt },
          ...session.getHistory(),
        ];

        const tools = this.getToolDefinitions();
        const request: ChatCompletionRequest = {
          model: this.config.model,
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          ...(this.config.maxTokens !== undefined
            ? { max_tokens: this.config.maxTokens }
            : {}),
        };

        // Accumulate deltas from stream
        let fullContent = "";
        const toolCallAccumulator = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        let finishReason: string | null = null;

        for await (const chunk of this.client.chatStream(request)) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          // Accumulate text content
          if (choice.delta.content) {
            fullContent += choice.delta.content;
            yield { type: "text_delta", content: choice.delta.content };
          }

          // Accumulate tool calls
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const existing = toolCallAccumulator.get(tc.index);
              if (existing) {
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                toolCallAccumulator.set(tc.index, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }

        // Process accumulated tool calls
        if (
          finishReason === "tool_calls" &&
          toolCallAccumulator.size > 0
        ) {
          // Build the assistant message with tool_calls for session history
          const toolCalls = [...toolCallAccumulator.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));

          session.addMessage({
            role: "assistant",
            content: fullContent,
            tool_calls: toolCalls,
          });

          // Execute each tool call
          for (const toolCall of toolCalls) {
            yield {
              type: "tool_start",
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
            };

            let args: Record<string, unknown>;
            try {
              args = JSON.parse(
                toolCall.function.arguments,
              ) as Record<string, unknown>;
            } catch {
              args = {};
            }

            const result = await this.orchestrator.execute({
              skillId: this.config.skillId,
              toolName: toolCall.function.name,
              args,
            });

            totalToolCalls++;

            const toolContent = result.success
              ? result.output
              : `Error: ${result.error ?? "Unknown error"}`;

            yield {
              type: "tool_result",
              toolCallId: toolCall.id,
              result: toolContent,
              success: result.success,
            };

            session.addMessage({
              role: "tool",
              content: toolContent,
              tool_call_id: toolCall.id,
            });
          }

          rounds++;

          if (rounds >= this.config.maxToolRounds) {
            const errorMessage = `Stopped after ${rounds} tool rounds (max: ${this.config.maxToolRounds}). Last content may be incomplete.`;
            session.addMessage({ role: "assistant", content: errorMessage });
            yield {
              type: "done",
              response: {
                message: errorMessage,
                toolCallsMade: totalToolCalls,
                model: this.config.model,
              },
            };
            return;
          }

          continue;
        }

        // No tool calls -- final response
        session.addMessage({ role: "assistant", content: fullContent });

        yield {
          type: "done",
          response: {
            message: fullContent,
            toolCallsMade: totalToolCalls,
            model: this.config.model,
          },
        };
        return;
      }
    } catch (err: unknown) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getToolDefinitions(): ToolDefinitionParam[] {
    // Access the tool registry through the orchestrator
    // The orchestrator has a private toolRegistry field — we access it
    // via the typed cast since the registry is passed in constructor
    const registry = (
      this.orchestrator as unknown as {
        toolRegistry: { list(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> };
      }
    ).toolRegistry;

    if (!registry) {
      return [];
    }

    return registry.list().map((handler) => ({
      type: "function" as const,
      function: {
        name: handler.name,
        description: handler.description,
        parameters: handler.parameters,
      },
    }));
  }
}
