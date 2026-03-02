import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setupChat } from "./chat.js";
import { CliAdapter } from "../adapter.js";
import type { Agent, Session } from "@safeclaw/core";

describe("setupChat", () => {
  it("wires adapter to agent — messages flow through", async () => {
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

    const session = {} as Session;

    setupChat(adapter, agent, session);
    await adapter.connect();

    input.write("user question\n");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).toHaveBeenCalledWith(
      session,
      "user question",
    );

    // Read output and check agent response is written
    const chunks: Buffer[] = [];
    let chunk: Buffer | null;
    while ((chunk = output.read() as Buffer | null) !== null) {
      chunks.push(chunk);
    }
    const out = Buffer.concat(chunks).toString();
    expect(out).toContain("agent response");

    await adapter.disconnect();
  });

  it("passes session to agent.processMessage", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new CliAdapter(input, output);

    const agent = {
      processMessage: vi.fn().mockResolvedValue({
        message: "ok",
        toolCallsMade: 0,
        model: "claude-sonnet-4",
      }),
    } as unknown as Agent;

    const session = { id: "test-session" } as unknown as Session;

    setupChat(adapter, agent, session);
    await adapter.connect();

    input.write("hello\n");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.processMessage).toHaveBeenCalledWith(session, "hello");

    await adapter.disconnect();
  });
});
