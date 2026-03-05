import type { Agent, Session, SessionManager, OutboundMessage } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";
import { ChatCommandHandler } from "./chat-commands.js";

export interface SetupChatOptions {
  sessionManager: SessionManager;
  model: string;
}

/**
 * Wire the CLI adapter to the agent for interactive chat (non-streaming).
 * When options are provided, slash commands are intercepted and handled locally.
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

  adapter.onMessage(async (msg) => {
    if (commandHandler?.isCommand(msg.content)) {
      const result = await commandHandler.execute(msg.content);
      return { content: result };
    }

    const response = await agent.processMessage(session, msg.content);
    return { content: response.message };
  });
}

/**
 * Wire the CLI adapter to the agent for streaming chat.
 * Text deltas are written to the terminal as they arrive.
 */
export function setupStreamingChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
): void {
  adapter.onStreamMessage(async function* (msg) {
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
          // Signal end of stream
          yield { content: "", stream: false } satisfies OutboundMessage;
          break;
        case "error":
          yield { content: `\nError: ${event.error}`, stream: false } satisfies OutboundMessage;
          break;
      }
    }
  });
}
