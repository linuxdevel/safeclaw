import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setupChat } from "./chat.js";
import { CliAdapter } from "../adapter.js";
import type { Agent, Session, SessionManager, AgentStreamEvent } from "@safeclaw/core";

async function* fakeStream(
  events: AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function makeTestDeps() {
  const input = new PassThrough();
  const output = new PassThrough();
  const adapter = new CliAdapter(input, output);

  const agent = {
    processMessageStream: vi.fn().mockReturnValue(
      fakeStream([
        { type: "text_delta", content: "agent response" },
        {
          type: "done",
          response: {
            message: "agent response",
            toolCallsMade: 0,
            model: "claude-sonnet-4",
          },
        },
      ]),
    ),
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
  it("streams agent response to terminal", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("user question\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessageStream).toHaveBeenCalledWith(session, "user question");
    const out = readOutput(output);
    expect(out).toContain("agent response");

    await adapter.disconnect();
  });

  it("saves session after stream completes", async () => {
    const { input, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessionManager.save).toHaveBeenCalledWith("test-id");

    await adapter.disconnect();
  });

  it("intercepts /help commands and does not call agent", async () => {
    const { input, output, adapter, agent, session, sessionManager } =
      makeTestDeps();

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("/help\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessageStream).not.toHaveBeenCalled();
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
    expect(agent.processMessageStream).not.toHaveBeenCalled();

    await adapter.disconnect();
  });

  it("still works with existing 3-arg signature (backward compat)", async () => {
    const { input, adapter, agent, session } = makeTestDeps();

    // Call without options — should still work, just no commands
    setupChat(adapter, agent, session);
    await adapter.connect();

    input.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessageStream).toHaveBeenCalledWith(session, "hello");

    await adapter.disconnect();
  });

  it("streams multiple text deltas incrementally", async () => {
    const { input, output, adapter, session, sessionManager } =
      makeTestDeps();

    const agent = {
      processMessageStream: vi.fn().mockReturnValue(
        fakeStream([
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
        ]),
      ),
    } as unknown as Agent;

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("Hi\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const out = readOutput(output);
    // Both deltas should appear in output (streamed directly, no newline between)
    expect(out).toContain("Hello world");

    await adapter.disconnect();
  });

  it("does not save session on error events", async () => {
    const { input, adapter, session, sessionManager } =
      makeTestDeps();

    const agent = {
      processMessageStream: vi.fn().mockReturnValue(
        fakeStream([
          { type: "error", error: "something broke" },
        ]),
      ),
    } as unknown as Agent;

    setupChat(adapter, agent, session, { sessionManager, model: "claude-sonnet-4" });
    await adapter.connect();

    input.write("fail\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessionManager.save).not.toHaveBeenCalled();

    await adapter.disconnect();
  });
});
