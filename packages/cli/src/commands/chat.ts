import type { Agent, Session, SessionManager, OutboundMessage } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";
import { ChatCommandHandler } from "./chat-commands.js";

export interface SetupChatOptions {
  sessionManager: SessionManager;
  model: string;
}

/**
 * Wire the CLI adapter to the agent for interactive streaming chat.
 *
 * Responses stream token-by-token to the terminal. Slash commands are
 * intercepted and handled locally before reaching the agent.
 * Sessions are persisted after each completed exchange.
 */
export function setupChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
  options?: SetupChatOptions,
): void {
  const commandHandler = options
    ? new ChatCommandHandler({
        session,
        sessionManager: options.sessionManager,
        agent,
        model: options.model,
      })
    : null;

  adapter.onStreamMessage(async function* (msg) {
    // Intercept slash commands — return a single non-streaming response
    if (commandHandler?.isCommand(msg.content)) {
      const result = await commandHandler.execute(msg.content);
      yield { content: result, stream: true } satisfies OutboundMessage;
      yield { content: "", stream: false } satisfies OutboundMessage;
      return;
    }

    // Stream agent response token-by-token
    const stream = agent.processMessageStream(session, msg.content);

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          yield { content: event.content, stream: true } satisfies OutboundMessage;
          break;
        case "tool_start":
          // Could emit a status indicator in the future
          break;
        case "tool_result":
          // Could emit tool status in the future
          break;
        case "done":
          // Persist session after completed exchange
          if (options?.sessionManager) {
            await options.sessionManager.save(session.id);
          }
          yield { content: "", stream: false } satisfies OutboundMessage;
          break;
        case "error":
          yield { content: `\nError: ${event.error}`, stream: false } satisfies OutboundMessage;
          break;
      }
    }
  });
}
