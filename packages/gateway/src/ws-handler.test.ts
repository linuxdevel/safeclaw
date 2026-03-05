import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { WebSocketHandler } from "./ws-handler.js";
import { RateLimiter } from "./rate-limit.js";
import { createServer, type Server } from "node:http";
import type { WsClientMessage, WsServerMessage } from "./ws-types.js";

const AUTH_TOKEN = "a]3Fk9!mP#nQ7wR$xY2zB&cD5eH8jL0v";

/** Helper: send a typed client message */
function wsSend(ws: WebSocket, msg: WsClientMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Helper: wait for the next server message */
function wsRecv(ws: WebSocket, timeoutMs = 2000): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WS message")),
      timeoutMs,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as WsServerMessage);
    });
  });
}

/** Helper: wait for WebSocket to open */
function wsOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

/** Helper: collect N server messages */
function wsRecvN(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<WsServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsServerMessage[] = [];
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for ${count} messages (got ${messages.length})`,
          ),
        ),
      timeoutMs,
    );
    const onMessage = (data: WebSocket.RawData): void => {
      messages.push(JSON.parse(String(data)) as WsServerMessage);
      if (messages.length === count) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(messages);
      }
    };
    ws.on("message", onMessage);
  });
}

/** Helper: wait for WebSocket to close */
function wsClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("WebSocketHandler - auth", () => {
  let server: Server;
  let handler: WebSocketHandler;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    handler = new WebSocketHandler({
      server,
      authToken: AUTH_TOKEN,
      rateLimiter: new RateLimiter(60, 60_000),
    });
    handler.attach();

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    handler.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("accepts auth with valid token as first message", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    const reply = await wsRecv(ws);

    expect(reply).toEqual({ type: "auth_ok" });
    ws.close();
  });

  it("rejects auth with invalid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: "wrong-token-that-is-long-enough!!" });
    const reply = await wsRecv(ws);

    expect(reply).toEqual({
      type: "auth_error",
      reason: "Invalid token",
    });

    // Connection should be closed by server
    const { code } = await wsClose(ws);
    expect(code).toBe(4001);
  });

  it("rejects non-auth message before authentication", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "chat", content: "hello" });
    const reply = await wsRecv(ws);

    expect(reply).toEqual({
      type: "auth_error",
      reason: "First message must be auth",
    });

    const { code } = await wsClose(ws);
    expect(code).toBe(4001);
  });

  it("closes connection on invalid JSON", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    ws.send("not valid json {{{");
    const reply = await wsRecv(ws);

    expect(reply.type).toBe("error");

    const { code } = await wsClose(ws);
    expect(code).toBe(4002);
  });

  it("accepts auth via query parameter on upgrade URL", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}?token=${encodeURIComponent(AUTH_TOKEN)}`,
    );
    await wsOpen(ws);

    // Should be pre-authenticated -- can send chat immediately
    // Send a ping to verify connection is authenticated
    wsSend(ws, { type: "ping" });
    const reply = await wsRecv(ws);

    expect(reply).toEqual({ type: "pong" });
    ws.close();
  });

  it("rejects upgrade with invalid query parameter token", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}?token=invalid-token-too-short`,
    );

    // Server rejects the HTTP upgrade with 401, so ws emits "error"
    // (not a WebSocket close frame — the connection never upgraded)
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", resolve);
    });
    expect(error.message).toMatch(/401/);
  });
});

describe("WebSocketHandler - chat messages", () => {
  let server: Server;
  let handler: WebSocketHandler;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    handler = new WebSocketHandler({
      server,
      authToken: AUTH_TOKEN,
      rateLimiter: new RateLimiter(60, 60_000),
    });

    handler.onMessage(async (_content, send) => {
      // Simulate streaming response
      send({ type: "text_delta", content: "Hello " });
      send({ type: "text_delta", content: "world" });
      send({
        type: "done",
        response: {
          message: "Hello world",
          toolCallsMade: 0,
          model: "test-model",
        },
      });
    });

    handler.attach();

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    handler.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("dispatches chat messages to handler after auth", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    // Authenticate first
    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    const authReply = await wsRecv(ws);
    expect(authReply.type).toBe("auth_ok");

    // Set up collection BEFORE sending chat to avoid race
    const messagesPromise = wsRecvN(ws, 3);

    // Send chat
    wsSend(ws, { type: "chat", content: "test message" });

    // Collect streaming responses
    const messages = await messagesPromise;

    expect(messages[0]).toEqual({ type: "text_delta", content: "Hello " });
    expect(messages[1]).toEqual({ type: "text_delta", content: "world" });
    expect(messages[2]).toEqual({
      type: "done",
      response: {
        message: "Hello world",
        toolCallsMade: 0,
        model: "test-model",
      },
    });

    ws.close();
  });

  it("responds to ping with pong after auth", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    await wsRecv(ws); // auth_ok

    wsSend(ws, { type: "ping" });
    const reply = await wsRecv(ws);

    expect(reply).toEqual({ type: "pong" });
    ws.close();
  });

  it("handles re-auth gracefully", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    const reply1 = await wsRecv(ws);
    expect(reply1.type).toBe("auth_ok");

    // Send auth again
    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    const reply2 = await wsRecv(ws);
    expect(reply2.type).toBe("auth_ok");

    ws.close();
  });
});

describe("WebSocketHandler - rate limiting", () => {
  let server: Server;
  let handler: WebSocketHandler;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    handler = new WebSocketHandler({
      server,
      authToken: AUTH_TOKEN,
      rateLimiter: new RateLimiter(2, 60_000), // Only 2 requests allowed
    });

    handler.onMessage(async (_content, send) => {
      send({
        type: "done",
        response: { message: "ok", toolCallsMade: 0, model: "test" },
      });
    });

    handler.attach();

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    handler.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("rate limits chat messages per connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    await wsRecv(ws); // auth_ok

    // First two chats should succeed
    wsSend(ws, { type: "chat", content: "msg1" });
    const r1 = await wsRecv(ws);
    expect(r1.type).toBe("done");

    wsSend(ws, { type: "chat", content: "msg2" });
    const r2 = await wsRecv(ws);
    expect(r2.type).toBe("done");

    // Third should be rate limited
    wsSend(ws, { type: "chat", content: "msg3" });
    const r3 = await wsRecv(ws);
    expect(r3).toEqual({ type: "error", message: "Rate limited" });

    ws.close();
  });

  it("does not rate limit ping messages", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}?token=${encodeURIComponent(AUTH_TOKEN)}`,
    );
    await wsOpen(ws);

    // Send many pings -- should all succeed regardless of rate limit
    for (let i = 0; i < 5; i++) {
      wsSend(ws, { type: "ping" });
      const reply = await wsRecv(ws);
      expect(reply.type).toBe("pong");
    }

    ws.close();
  });
});

describe("WebSocketHandler - connection lifecycle", () => {
  let server: Server;
  let handler: WebSocketHandler;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    handler = new WebSocketHandler({
      server,
      authToken: AUTH_TOKEN,
      rateLimiter: new RateLimiter(60, 60_000),
    });
    handler.attach();

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    handler.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("handles client disconnection cleanly", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    await wsRecv(ws); // auth_ok

    // Close from client side
    ws.close();

    // Should not throw -- server handles cleanup
    await new Promise((r) => setTimeout(r, 50));
  });

  it("supports multiple concurrent connections", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);

    await Promise.all([wsOpen(ws1), wsOpen(ws2)]);

    // Auth both
    wsSend(ws1, { type: "auth", token: AUTH_TOKEN });
    wsSend(ws2, { type: "auth", token: AUTH_TOKEN });

    const [r1, r2] = await Promise.all([wsRecv(ws1), wsRecv(ws2)]);
    expect(r1.type).toBe("auth_ok");
    expect(r2.type).toBe("auth_ok");

    // Both should respond to pings independently
    wsSend(ws1, { type: "ping" });
    wsSend(ws2, { type: "ping" });

    const [p1, p2] = await Promise.all([wsRecv(ws1), wsRecv(ws2)]);
    expect(p1.type).toBe("pong");
    expect(p2.type).toBe("pong");

    ws1.close();
    ws2.close();
  });

  it("close() terminates all active connections", async () => {
    // Create a separate handler for this test so we can call close() safely
    const testServer = createServer();
    const testHandler = new WebSocketHandler({
      server: testServer,
      authToken: AUTH_TOKEN,
      rateLimiter: new RateLimiter(60, 60_000),
    });
    testHandler.attach();

    await new Promise<void>((resolve, reject) => {
      testServer.on("error", reject);
      testServer.listen(0, "127.0.0.1", resolve);
    });

    const testAddr = testServer.address();
    const testPort =
      testAddr && typeof testAddr === "object" ? testAddr.port : 0;

    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await wsOpen(ws);

    wsSend(ws, { type: "auth", token: AUTH_TOKEN });
    await wsRecv(ws); // auth_ok

    const closePromise = wsClose(ws);

    // Server-side close
    testHandler.close();

    const { code } = await closePromise;
    expect(code).toBe(1001); // "Going Away"

    await new Promise<void>((resolve) => {
      testServer.close(() => resolve());
    });
  });
});
