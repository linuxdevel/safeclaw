import type { CopilotClient } from "../copilot/client.js";
import type { ChatMessage, CopilotModel } from "../copilot/types.js";

export interface ContextCompactorConfig {
  client: CopilotClient;
  model: CopilotModel;
  maxContextTokens: number;
  preserveRecentMessages: number;
}

export class ContextCompactor {
  private readonly client: CopilotClient;
  private readonly model: CopilotModel;
  private readonly maxContextTokens: number;
  private readonly preserveRecentMessages: number;

  constructor(config: ContextCompactorConfig) {
    this.client = config.client;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens;
    this.preserveRecentMessages = config.preserveRecentMessages;
  }

  /**
   * Rough token estimate: ~1 token per 4 characters of content,
   * plus 4 tokens overhead per message for role/structure.
   */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // Content tokens
      total += Math.ceil(msg.content.length / 4);
      // Overhead per message (role, separators)
      total += 4;
      // tool_calls contribute additional tokens
      if (msg.tool_calls) {
        const serialized = JSON.stringify(msg.tool_calls);
        total += Math.ceil(serialized.length / 4);
      }
    }
    return total;
  }

  /**
   * Returns true when prompt_tokens exceeds 80% of maxContextTokens.
   */
  shouldCompact(tokenCount: number): boolean {
    return tokenCount >= this.maxContextTokens * 0.8;
  }

  /**
   * Compact conversation history by summarizing older messages.
   *
   * 1. Split history into "old" (to summarize) and "recent" (to preserve).
   * 2. Adjust the split point so tool-call/tool-result pairs are never broken.
   * 3. Send old messages to LLM for summarization.
   * 4. Return [summary_message, ...recent_messages].
   */
  async compact(history: ChatMessage[]): Promise<ChatMessage[]> {
    // Not enough messages to compact
    if (history.length <= this.preserveRecentMessages) {
      return history;
    }

    // Find the split point
    let splitIndex = history.length - this.preserveRecentMessages;

    // Adjust split point backwards to avoid breaking tool-call groups.
    // A tool-call group is: assistant with tool_calls → one or more tool results.
    // If the split lands inside a group, back up to include the whole group.
    splitIndex = this.adjustSplitForToolGroups(history, splitIndex);

    // If adjustment consumed everything, nothing to summarize
    if (splitIndex <= 0) {
      return history;
    }

    const oldMessages = history.slice(0, splitIndex);
    const recentMessages = history.slice(splitIndex);

    // Summarize old messages via LLM
    const summary = await this.summarize(oldMessages);

    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[Previous conversation summary]\n${summary}`,
    };

    return [summaryMessage, ...recentMessages];
  }

  /**
   * Adjust split index backwards so we don't break apart
   * assistant+tool_calls / tool-result groups.
   */
  private adjustSplitForToolGroups(
    history: ChatMessage[],
    splitIndex: number,
  ): number {
    // If the message at splitIndex is a tool result, back up to include
    // the preceding assistant+tool_calls message and all related tool results.
    while (splitIndex > 0 && history[splitIndex]?.role === "tool") {
      splitIndex--;
    }
    // If we landed on an assistant with tool_calls, include it too
    while (
      splitIndex > 0 &&
      history[splitIndex]?.role === "assistant" &&
      history[splitIndex]?.tool_calls &&
      history[splitIndex]!.tool_calls!.length > 0
    ) {
      splitIndex--;
    }
    return splitIndex;
  }

  /**
   * Call the LLM to produce a concise summary of the given messages.
   */
  private async summarize(messages: ChatMessage[]): Promise<string> {
    // Build a text representation of old messages for summarization.
    // Strip tool_calls metadata — just include the content.
    const conversationText = messages
      .map((m) => {
        const prefix = m.role === "tool" ? "tool-result" : m.role;
        return `[${prefix}]: ${m.content}`;
      })
      .join("\n");

    const response = await this.client.chat({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "You are a conversation summarizer. Summarize the following conversation concisely. " +
            "Preserve key facts, decisions, file paths, code snippets, and any important context " +
            "the user or assistant referenced. Be factual and brief. Output only the summary.",
        },
        {
          role: "user",
          content: conversationText,
        },
      ],
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No choices in summarization response");
    }
    return choice.message.content;
  }
}
