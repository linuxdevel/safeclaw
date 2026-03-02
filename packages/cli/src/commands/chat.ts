import type { Agent, Session } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";

/**
 * Wire the CLI adapter to the agent for interactive chat.
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
