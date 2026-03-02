import type { CopilotClient } from "../copilot/client.js";
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
  private readonly client: CopilotClient;
  private readonly orchestrator: ToolOrchestrator;

  constructor(
    config: AgentConfig,
    client: CopilotClient,
    orchestrator: ToolOrchestrator,
  ) {
    this.config = config;
    this.client = client;
    this.orchestrator = orchestrator;
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
            skillId: "agent",
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

  getToolDefinitions(): ToolDefinitionParam[] {
    // Access the tool registry through the orchestrator
    // The orchestrator has a private toolRegistry field — we access it
    // via the typed cast since the registry is passed in constructor
    const registry = (
      this.orchestrator as unknown as {
        toolRegistry: { list(): Array<{ name: string; description: string }> };
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
        parameters: {},
      },
    }));
  }
}
