import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { WebChatAdapter } from "./adapter.js";

describe("WebChatAdapter", () => {
  let adapter: WebChatAdapter;

  beforeEach(() => {
    adapter = new WebChatAdapter({ port: 0, staticDir: false });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it("has correct id", () => {
    expect(adapter.id).toBe("webchat");
  });

  it("connect sets running state", async () => {
    await adapter.connect();
    expect(adapter.isRunning).toBe(true);
  });

  it("disconnect clears running state", async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isRunning).toBe(false);
  });

  it("disconnect is safe to call multiple times", async () => {
    await adapter.connect();
    await adapter.disconnect();
    await adapter.disconnect();
    expect(adapter.isRunning).toBe(false);
  });

  it("onMessage stores the handler", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "ok" });
    adapter.onMessage(handler);

    await adapter.connect();
    const result = await adapter.handleChatMessage("user1", "hello");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { channelId: "webchat", peerId: "user1" },
        content: "hello",
        timestamp: expect.any(Date),
      }),
    );
    expect(result).toEqual({ content: "ok" });
  });

  it("handleChatMessage returns error when no handler registered", async () => {
    await adapter.connect();
    const result = await adapter.handleChatMessage("user1", "hello");

    expect(result.content).toContain("No handler");
  });

  it("handleChatMessage returns error when not connected", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "ok" });
    adapter.onMessage(handler);

    const result = await adapter.handleChatMessage("user1", "hello");

    expect(result.content).toContain("not connected");
    expect(handler).not.toHaveBeenCalled();
  });

  it("send is a no-op that does not throw", async () => {
    await adapter.connect();
    await expect(
      adapter.send(
        { channelId: "webchat", peerId: "user1" },
        { content: "ignored" },
      ),
    ).resolves.toBeUndefined();
  });

  it("handleChatMessage uses different peer IDs", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "reply" });
    adapter.onMessage(handler);
    await adapter.connect();

    await adapter.handleChatMessage("alice", "hi");
    await adapter.handleChatMessage("bob", "hey");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { channelId: "webchat", peerId: "alice" },
      }),
    );
    expect(handler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { channelId: "webchat", peerId: "bob" },
      }),
    );
  });

  it("handleChatMessage propagates handler errors as error response", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("agent crash"));
    adapter.onMessage(handler);
    await adapter.connect();

    const result = await adapter.handleChatMessage("user1", "boom");

    expect(result.content).toContain("agent crash");
  });
});

describe("WebChatAdapter with static file server", () => {
  let adapter: WebChatAdapter;

  afterEach(async () => {
    await adapter.disconnect();
  });

  it("starts HTTP server on connect and stops on disconnect", async () => {
    adapter = new WebChatAdapter({ port: 0 });
    await adapter.connect();

    expect(adapter.isRunning).toBe(true);
    expect(adapter.port).toBeGreaterThan(0);

    await adapter.disconnect();
    expect(adapter.isRunning).toBe(false);
  });

  it("serves static files over HTTP", async () => {
    adapter = new WebChatAdapter({ port: 0 });
    await adapter.connect();

    const port = adapter.port;
    const res = await fetch(`http://127.0.0.1:${port}/`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
    expect(text).toContain("SafeClaw");
  });

  it("serves CSS file with correct content-type", async () => {
    adapter = new WebChatAdapter({ port: 0 });
    await adapter.connect();

    const port = adapter.port;
    const res = await fetch(`http://127.0.0.1:${port}/style.css`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("serves JS file with correct content-type", async () => {
    adapter = new WebChatAdapter({ port: 0 });
    await adapter.connect();

    const port = adapter.port;
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("returns 404 for unknown paths", async () => {
    adapter = new WebChatAdapter({ port: 0 });
    await adapter.connect();

    const port = adapter.port;
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);

    expect(res.status).toBe(404);
  });
});
