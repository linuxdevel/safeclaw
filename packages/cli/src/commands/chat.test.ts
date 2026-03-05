import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setupChat } from "./chat.js";
import { CliAdapter } from "../adapter.js";
import type { Agent, Session, SessionManager } from "@safeclaw/core";

function makeTestDeps() {
  const input = new PassThrough();
  const output = new PassThrough();
  const adapter = new CliAdapter(input, output);

  const agent = {
    processMessage: vi.fn().mockResolvedValue({
      message: "agent response",
      toolCallsMade: 0,
      model: "claude-sonnet-4",
    }),
  } as unknown as Agent;

  const session = {
    id: "test-id",
    metadata: {
      id: "test-id",
      peer: { channelId: "cli", peerId: "local" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:01:00Z"),
      messageCount: 5,
    },
    clearHistory: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  } as unknown as Session;

  const sessionManager = {
    activeCount: 1,
    listSessions: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;

  return { input, output, adapter, agent, session, sessionManager };
}

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

describe("setupChat", () => {
  it("passes regular messages to agent", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("user question\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).toHaveBeenCalledWith(session, "user question");
    const out = readOutput(output);
    expect(out).toContain("agent response");

    await adapter.disconnect();
  });

  it("intercepts /help commands and does not call agent", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("/help\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).not.toHaveBeenCalled();
    const out = readOutput(output);
    expect(out).toContain("/new");
    expect(out).toContain("/status");

    await adapter.disconnect();
  });

  it("intercepts /new and clears session history", async () => {
    const { input, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("/new\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(session.clearHistory).toHaveBeenCalled();
    expect(agent.processMessage).not.toHaveBeenCalled();

    await adapter.disconnect();
  });

  it("still works with existing 3-arg signature (backward compat)", async () => {
    const { input, adapter, agent, session } = makeTestDeps();

    // Call without options — should still work, just no commands
    setupChat(adapter, agent, session);
    await adapter.connect();

    input.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).toHaveBeenCalledWith(session, "hello");

    await adapter.disconnect();
  });
});

// --- Streaming chat tests ---

import { setupStreamingChat } from "./chat.js";
import type { AgentStreamEvent } from "@safeclaw/core";

async function* fakeStream(
  events: AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createStreamChatMocks() {
  const adapter = {
    onMessage: vi.fn(),
    onStreamMessage: vi.fn(),
    peer: { channelId: "cli", peerId: "local" },
  } as unknown as CliAdapter;

  const agent = {
    processMessageStream: vi.fn(),
  } as unknown as Agent;

  const session = {} as Session;

  return { adapter, agent, session };
}

describe("setupStreamingChat", () => {
  it("registers a stream handler on the adapter", () => {
    const { adapter, agent, session } = createStreamChatMocks();
    setupStreamingChat(adapter, agent, session);
    expect(adapter.onStreamMessage).toHaveBeenCalledWith(expect.any(Function));
  });

  it("handler calls processMessageStream and yields text deltas", async () => {
    const { adapter, agent, session } = createStreamChatMocks();

    const events: AgentStreamEvent[] = [
      { type: "text_delta", content: "Hello" },
      { type: "text_delta", content: " world" },
      {
        type: "done",
        response: {
          message: "Hello world",
          toolCallsMade: 0,
          model: "claude-sonnet-4",
        },
      },
    ];

    vi.mocked(agent.processMessageStream).mockReturnValue(
      fakeStream(events),
    );

    setupStreamingChat(adapter, agent, session);

    // Get the handler that was registered
    const handler = vi.mocked(adapter.onStreamMessage).mock.calls[0]![0] as (
      msg: { peer: { channelId: string; peerId: string }; content: string; timestamp: Date },
    ) => AsyncIterable<{ content: string; stream?: boolean }>;

    const outbound: Array<{ content: string; stream?: boolean }> = [];
    for await (const msg of handler({
      peer: { channelId: "cli", peerId: "local" },
      content: "Hi",
      timestamp: new Date(),
    })) {
      outbound.push(msg);
    }

    expect(outbound).toEqual([
      { content: "Hello", stream: true },
      { content: " world", stream: true },
      { content: "", stream: false },
    ]);
  });
});
