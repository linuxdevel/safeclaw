import type { Agent, Session, OutboundMessage } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";

/**
 * Wire the CLI adapter to the agent for interactive chat (non-streaming).
 */
export function setupChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
): void {
  adapter.onMessage(async (msg) => {
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
