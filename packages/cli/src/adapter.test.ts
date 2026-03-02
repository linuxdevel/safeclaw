import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { CliAdapter } from "./adapter.js";

function createStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output };
}

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

describe("CliAdapter", () => {
  let adapter: CliAdapter;
  let input: PassThrough;
  let output: PassThrough;

  beforeEach(() => {
    const streams = createStreams();
    input = streams.input;
    output = streams.output;
    adapter = new CliAdapter(input, output);
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it("has correct id", () => {
    expect(adapter.id).toBe("cli");
  });

  it("has correct peer identity", () => {
    expect(adapter.peer).toEqual({ channelId: "cli", peerId: "local" });
  });

  it("connect creates readline interface", async () => {
    await adapter.connect();
    // After connect, the prompt should have been written
    const out = readOutput(output);
    expect(out).toContain("> ");
  });

  it("disconnect closes readline", async () => {
    await adapter.connect();
    await adapter.disconnect();
    // Should not throw when disconnecting again
    await adapter.disconnect();
  });

  it("onMessage handler is called when line is received", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "response" });
    adapter.onMessage(handler);

    await adapter.connect();

    // Write a line to input
    input.write("hello\n");

    // Give event loop time to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { channelId: "cli", peerId: "local" },
        content: "hello",
        timestamp: expect.any(Date),
      }),
    );
  });

  it("send writes content to output stream", async () => {
    await adapter.connect();

    // Drain the prompt
    readOutput(output);

    await adapter.send(
      { channelId: "cli", peerId: "local" },
      { content: "test message" },
    );

    const out = readOutput(output);
    expect(out).toContain("test message");
  });

  it("ignores empty lines", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "response" });
    adapter.onMessage(handler);

    await adapter.connect();

    input.write("   \n");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).not.toHaveBeenCalled();
  });

  it("response from handler is sent to output", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "bot reply" });
    adapter.onMessage(handler);

    await adapter.connect();

    // Drain the initial prompt
    readOutput(output);

    input.write("user input\n");

    await new Promise((resolve) => setTimeout(resolve, 50));

    const out = readOutput(output);
    expect(out).toContain("bot reply");
  });
});
