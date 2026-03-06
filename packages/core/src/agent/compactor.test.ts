import { describe, it, expect, vi } from "vitest";
import { ContextCompactor } from "./compactor.js";
import type { ModelProvider } from "../providers/types.js";
import type { ChatMessage } from "../copilot/types.js";

function makeCompactor(overrides: { maxContextTokens?: number; preserveRecentMessages?: number } = {}) {
  const client = { chat: vi.fn() } as unknown as ModelProvider;
  return { compactor: new ContextCompactor({
    provider: client,
    model: "claude-sonnet-4",
    maxContextTokens: overrides.maxContextTokens ?? 1000,
    preserveRecentMessages: overrides.preserveRecentMessages ?? 10,
  }), client };
}

describe("ContextCompactor", () => {
  describe("estimateTokens", () => {
    it("estimates roughly 1 token per 4 characters", () => {
      const { compactor } = makeCompactor();
      // 40 chars of content → ~10 tokens, plus role/structure overhead
      const messages: ChatMessage[] = [
        { role: "user", content: "a".repeat(40) },
      ];
      const estimate = compactor.estimateTokens(messages);
      // Should be roughly 10 + overhead per message (4 tokens for role/structure)
      expect(estimate).toBeGreaterThanOrEqual(10);
      expect(estimate).toBeLessThan(30);
    });

    it("returns 0 for empty message array", () => {
      const { compactor } = makeCompactor();
      expect(compactor.estimateTokens([])).toBe(0);
    });

    it("accounts for tool_calls JSON in estimation", () => {
      const { compactor } = makeCompactor();
      const withoutToolCalls: ChatMessage[] = [
        { role: "assistant", content: "hello" },
      ];
      const withToolCalls: ChatMessage[] = [
        {
          role: "assistant",
          content: "hello",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/test"}' } },
          ],
        },
      ];
      expect(compactor.estimateTokens(withToolCalls)).toBeGreaterThan(
        compactor.estimateTokens(withoutToolCalls),
      );
    });
  });

  describe("shouldCompact", () => {
    it("returns false when token count is below 80% threshold", () => {
      const { compactor } = makeCompactor({ maxContextTokens: 1000 });
      expect(compactor.shouldCompact(799)).toBe(false);
    });

    it("returns true when token count is at 80% threshold", () => {
      const { compactor } = makeCompactor({ maxContextTokens: 1000 });
      expect(compactor.shouldCompact(800)).toBe(true);
    });

    it("returns true when token count exceeds 80% threshold", () => {
      const { compactor } = makeCompactor({ maxContextTokens: 1000 });
      expect(compactor.shouldCompact(900)).toBe(true);
    });
  });

  describe("compact", () => {
    it("preserves the last N messages and summarizes the rest", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 1000,
        preserveRecentMessages: 2,
      });

      const history: ChatMessage[] = [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
        { role: "assistant", content: "Second answer" },
        { role: "user", content: "Recent question" },
        { role: "assistant", content: "Recent answer" },
      ];

      vi.mocked(client.chat).mockResolvedValue({
        id: "resp-summary",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Summary: User asked two questions and got answers." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      });

      const result = await compactor.compact(history);

      // Should have: 1 summary message + 2 preserved messages
      expect(result).toHaveLength(3);
      expect(result[0]!.role).toBe("user");
      expect(result[0]!.content).toContain("[Previous conversation summary]");
      expect(result[0]!.content).toContain("Summary: User asked two questions and got answers.");
      // Recent messages preserved
      expect(result[1]!.content).toBe("Recent question");
      expect(result[2]!.content).toBe("Recent answer");
    });

    it("does not split assistant+tool_calls from following tool results", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 1000,
        preserveRecentMessages: 2,
      });

      // History where the 3rd-from-last message is a tool result
      // that pairs with a preceding assistant+tool_calls message.
      // preserveRecentMessages=2 would naively split them.
      const history: ChatMessage[] = [
        { role: "user", content: "Old message" },
        { role: "assistant", content: "Old reply" },
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp"}' } }],
        },
        { role: "tool", content: "file contents here", tool_call_id: "call_1" },
        { role: "assistant", content: "Here is what I found" },
      ];

      vi.mocked(client.chat).mockResolvedValue({
        id: "resp-summary",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Summary of old conversation." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      });

      const result = await compactor.compact(history);

      // The tool-call group (assistant+tool_calls, tool result, final assistant)
      // should be kept together. With preserveRecentMessages=2,
      // the split point must back up to include the full tool-call group.
      // Preserved: messages[2..5] (user "Do something", assistant+tool_calls, tool result, final assistant)
      // Summarized: messages[0..1]
      expect(result.length).toBeGreaterThanOrEqual(3);
      // No tool result should appear in summarized portion
      const summaryMsg = result[0]!;
      expect(summaryMsg.content).toContain("[Previous conversation summary]");
      // The tool result and its assistant should be in preserved portion
      const preserved = result.slice(1);
      const hasToolResult = preserved.some((m) => m.role === "tool");
      const hasToolCalls = preserved.some((m) => m.tool_calls && m.tool_calls.length > 0);
      expect(hasToolResult).toBe(true);
      expect(hasToolCalls).toBe(true);
    });

    it("returns history unchanged when too few messages to compact", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 1000,
        preserveRecentMessages: 10,
      });

      const history: ChatMessage[] = [
        { role: "user", content: "Short conversation" },
        { role: "assistant", content: "Short reply" },
      ];

      const result = await compactor.compact(history);

      // Fewer messages than preserveRecentMessages → return unchanged
      expect(result).toEqual(history);
      // Should NOT have called the LLM
      expect(client.chat).not.toHaveBeenCalled();
    });

    it("sends old messages to LLM with summarization prompt", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 1000,
        preserveRecentMessages: 1,
      });

      const history: ChatMessage[] = [
        { role: "user", content: "Tell me about X" },
        { role: "assistant", content: "X is a thing that does Y" },
        { role: "user", content: "Thanks" },
      ];

      vi.mocked(client.chat).mockResolvedValue({
        id: "resp-summary",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "User asked about X. Assistant explained X does Y." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      });

      await compactor.compact(history);

      // Verify LLM was called with summarization system prompt and old messages
      const chatCall = vi.mocked(client.chat).mock.calls[0]![0];
      expect(chatCall.model).toBe("claude-sonnet-4");
      expect(chatCall.messages[0]!.role).toBe("system");
      expect(chatCall.messages[0]!.content).toContain("summarize");
      // Old messages should be included
      const msgContents = chatCall.messages.map((m) => m.content);
      expect(msgContents.some((c) => c.includes("Tell me about X"))).toBe(true);
    });

    it("falls back to simple truncation when summarization fails", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 1000,
        preserveRecentMessages: 2,
      });

      const history: ChatMessage[] = [
        { role: "user", content: "Old question 1" },
        { role: "assistant", content: "Old answer 1" },
        { role: "user", content: "Old question 2" },
        { role: "assistant", content: "Old answer 2" },
        { role: "user", content: "Recent question" },
        { role: "assistant", content: "Recent answer" },
      ];

      // Summarization throws (e.g., API error, context overflow)
      vi.mocked(client.chat).mockRejectedValue(
        new Error("Chat request failed: 400 Bad Request"),
      );

      const result = await compactor.compact(history);

      // Should fall back: 1 marker message + 2 preserved
      expect(result).toHaveLength(3);
      expect(result[0]!.role).toBe("user");
      expect(result[0]!.content).toContain("4 messages omitted");
      expect(result[0]!.content).toContain("context limits");
      expect(result[1]!.content).toBe("Recent question");
      expect(result[2]!.content).toBe("Recent answer");
    });

    it("caps summarization input to avoid overflowing context window", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      // Small context window — maxContextTokens=100 means max ~25 chars for summarization
      // (but floor of 5000 chars applies, so we use a larger context window)
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 20_000,
        preserveRecentMessages: 1,
      });

      const history: ChatMessage[] = [
        { role: "user", content: "a".repeat(20_000) },    // Way too large for budget
        { role: "assistant", content: "b".repeat(20_000) },
        { role: "user", content: "c".repeat(50) },     // Fits
        { role: "assistant", content: "d".repeat(50) }, // Fits
        { role: "user", content: "Recent" },
      ];

      vi.mocked(client.chat).mockResolvedValue({
        id: "resp-summary",
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Summary of recent old messages." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      });

      await compactor.compact(history);

      // The summarization text sent to the LLM should be capped
      const chatCall = vi.mocked(client.chat).mock.calls[0]![0];
      const userMessage = chatCall.messages[1]!.content;

      // The capped text should include the "omitted" marker since
      // the earliest messages don't fit within maxContextTokens/4 = 5000 chars
      expect(userMessage).toContain("omitted");
      // Should be well under the full size (40K+ chars uncapped)
      expect(userMessage.length).toBeLessThanOrEqual(6_000);
    });

    it("skips summarization and truncates directly when history is massively oversized", async () => {
      const client = { chat: vi.fn() } as unknown as ModelProvider;
      const compactor = new ContextCompactor({
        provider: client,
        model: "claude-sonnet-4",
        maxContextTokens: 1000,  // 1000 tokens = ~4000 chars
        preserveRecentMessages: 2,
      });

      // Create history whose old messages estimate to >= 1.5x context window (1500+ tokens)
      // Each message: 4000 chars = ~1000 tokens. 3 messages = ~3000 tokens >> 1500 threshold.
      const history: ChatMessage[] = [
        { role: "user", content: "x".repeat(4000) },
        { role: "assistant", content: "y".repeat(4000) },
        { role: "user", content: "z".repeat(4000) },
        { role: "assistant", content: "w".repeat(4000) },
        { role: "user", content: "Recent question" },
        { role: "assistant", content: "Recent answer" },
      ];

      const result = await compactor.compact(history);

      // Should NOT have called the LLM — fast path truncation
      expect(client.chat).not.toHaveBeenCalled();

      // Should have: 1 truncation marker + 2 preserved
      expect(result).toHaveLength(3);
      expect(result[0]!.role).toBe("user");
      expect(result[0]!.content).toContain("4 messages");
      expect(result[0]!.content).toContain("truncated");
      expect(result[0]!.content).toContain("tokens");
      expect(result[1]!.content).toBe("Recent question");
      expect(result[2]!.content).toBe("Recent answer");
    });
  });
});
