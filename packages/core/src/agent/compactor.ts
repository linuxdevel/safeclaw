import type { ModelProvider } from "../providers/types.js";
import type { ChatMessage, CopilotModel } from "../copilot/types.js";

export interface ContextCompactorConfig {
  provider: ModelProvider;
  model: CopilotModel;
  maxContextTokens: number;
  preserveRecentMessages: number;
}

export class ContextCompactor {
  private readonly provider: ModelProvider;
  private readonly model: CopilotModel;
  private readonly maxContextTokens: number;
  private readonly preserveRecentMessages: number;

  constructor(config: ContextCompactorConfig) {
    this.provider = config.provider;
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
   * 3. If old messages are extremely large (>= 2x context window), skip
   *    summarization and truncate immediately — no point calling the API
   *    with a payload that will hang or overflow.
   * 4. Otherwise send old messages to LLM for summarization.
   * 5. Return [summary_message, ...recent_messages].
   *
   * If summarization fails (API error, timeout, payload too large), falls
   * back to simple truncation — old messages are discarded with a marker.
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

    // Fast path: if the old messages are massively oversized (estimated at
    // >= 1.5x the context window), skip summarization entirely.  Sending
    // this much text to the API will likely hang or fail anyway.
    const oldTokens = this.estimateTokens(oldMessages);
    if (oldTokens >= this.maxContextTokens * 1.5) {
      const fallbackMessage: ChatMessage = {
        role: "user",
        content:
          `[Previous conversation: ${oldMessages.length} messages (~${oldTokens} tokens) truncated due to context limits]`,
      };
      return [fallbackMessage, ...recentMessages];
    }

    // Try to summarize; fall back to simple truncation on failure.
    let summary: string;
    try {
      summary = await this.summarize(oldMessages);
    } catch {
      // Summarization failed (API error, context overflow, timeout, etc.).
      // Fall back: discard old messages with a brief marker.
      const fallbackMessage: ChatMessage = {
        role: "user",
        content:
          `[Previous conversation: ${oldMessages.length} messages omitted due to context limits]`,
      };
      return [fallbackMessage, ...recentMessages];
    }

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
   *
   * If the conversation text exceeds half the context window, only the
   * most recent old messages are included to stay within budget.
   */
  private async summarize(messages: ChatMessage[]): Promise<string> {
    // Build a text representation of old messages for summarization.
    // Strip tool_calls metadata — just include the content.
    const conversationText = this.buildSummarizationText(messages);

    const response = await this.provider.chat({
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

  /**
   * Build the text payload for summarization, capping at a reasonable
   * budget.  If messages exceed the budget, only the most recent ones
   * are included (with a note about omitted earlier messages).
   *
   * Budget: maxContextTokens / 4 characters.  At ~4 chars per token
   * this is roughly maxContextTokens / 16 tokens — well within the
   * model's limits while leaving ample room for output and system prompt.
   */
  private buildSummarizationText(messages: ChatMessage[]): string {
    const maxChars = Math.max(this.maxContextTokens / 4, 5_000);

    // Build lines from newest to oldest, stop when we exceed budget
    const lines: string[] = [];
    let totalChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const prefix = m.role === "tool" ? "tool-result" : m.role;
      const line = `[${prefix}]: ${m.content}`;

      if (totalChars + line.length > maxChars && lines.length > 0) {
        // Would exceed budget — stop here
        lines.push(`[...${i + 1} earlier messages omitted...]`);
        break;
      }

      lines.push(line);
      totalChars += line.length;
    }

    // Reverse back to chronological order
    lines.reverse();
    return lines.join("\n");
  }
}
