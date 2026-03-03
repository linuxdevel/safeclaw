# WebSocket Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add WebSocket support to the gateway for real-time streaming responses and bidirectional communication alongside the existing HTTP endpoint.

**Architecture:** Use the `ws` npm package to add a WebSocket upgrade handler to the existing HTTP server in `Gateway`. Clients authenticate by sending an `auth` message as the first WebSocket frame (or via `?token=` query parameter on the upgrade URL). Once authenticated, the connection receives JSON-typed events matching the `AgentStreamEvent` discriminated union from the streaming plan. The existing `POST /api/chat` endpoint is untouched. Rate limiting applies per-connection using the same `RateLimiter` infrastructure.

**Tech Stack:** TypeScript, ws (npm), Vitest

---

## Task 1: Add `ws` dependency

**Files:**
- Modify: `packages/gateway/package.json:11-13`

**Step 1: Install `ws` and its type declarations**

Run: `pnpm add ws --filter @safeclaw/gateway && pnpm add -D @types/ws --filter @safeclaw/gateway`

**Step 2: Verify `package.json` was updated**

Confirm `packages/gateway/package.json` now has `"ws"` in `dependencies` and `"@types/ws"` in `devDependencies`.

**Step 3: Commit**

```bash
git add packages/gateway/package.json pnpm-lock.yaml
git commit -m "chore(gateway): add ws and @types/ws dependencies"
```

---

## Task 2: Define WebSocket message protocol types

**Files:**
- Create: `packages/gateway/src/ws-types.ts`

**Step 1: Write the type definitions**

```typescript
// --- Client -> Server messages ---

export interface WsAuthMessage {
  type: "auth";
  token: string;
}

export interface WsChatMessage {
  type: "chat";
  content: string;
}

export interface WsPingMessage {
  type: "ping";
}

export type WsClientMessage = WsAuthMessage | WsChatMessage | WsPingMessage;

// --- Server -> Client messages ---

export interface WsAuthOkMessage {
  type: "auth_ok";
}

export interface WsAuthErrorMessage {
  type: "auth_error";
  reason: string;
}

export interface WsTextDeltaMessage {
  type: "text_delta";
  content: string;
}

export interface WsToolStartMessage {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
}

export interface WsToolResultMessage {
  type: "tool_result";
  toolCallId: string;
  result: string;
  success: boolean;
}

export interface WsDoneMessage {
  type: "done";
  response: {
    message: string;
    toolCallsMade: number;
    model: string;
  };
}

export interface WsErrorMessage {
  type: "error";
  message: string;
}

export interface WsPongMessage {
  type: "pong";
}

export type WsServerMessage =
  | WsAuthOkMessage
  | WsAuthErrorMessage
  | WsTextDeltaMessage
  | WsToolStartMessage
  | WsToolResultMessage
  | WsDoneMessage
  | WsErrorMessage
  | WsPongMessage;
```

**Step 2: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 3: Commit**

```bash
git add packages/gateway/src/ws-types.ts
git commit -m "feat(gateway): define WebSocket message protocol types"
```

---

## Task 3: Write failing tests for WebSocketHandler -- auth flow

**Files:**
- Create: `packages/gateway/src/ws-handler.test.ts`

The test file uses the `ws` client library to connect to a real WebSocket server. Each test starts a Gateway, opens a WS connection, and asserts on the protocol behavior. We write all auth tests first, then message tests in later tasks.

**Step 1: Write the auth test file**

```typescript
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

    const closePromise = wsClose(ws);
    const { code } = await closePromise;
    // Server should reject the upgrade or close immediately
    expect(code).toBe(4001);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/gateway/src/ws-handler.test.ts`
Expected: FAIL -- `Cannot find module './ws-handler.js'`

**Step 3: Commit**

```bash
git add packages/gateway/src/ws-handler.test.ts
git commit -m "test(gateway): add failing WebSocket auth tests"
```

---

## Task 4: Implement WebSocketHandler -- auth and connection management

**Files:**
- Create: `packages/gateway/src/ws-handler.ts`

**Step 1: Write the WebSocketHandler class**

```typescript
import { WebSocketServer, type WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import { verifyToken } from "./auth.js";
import type { RateLimiter } from "./rate-limit.js";
import type { WsClientMessage, WsServerMessage } from "./ws-types.js";

export interface WebSocketHandlerConfig {
  server: Server;
  authToken: string;
  rateLimiter: RateLimiter;
}

/** Handler for a single authenticated connection */
interface AuthenticatedConnection {
  ws: WebSocket;
  clientId: string;
  authenticated: boolean;
}

export type WsMessageHandler = (
  content: string,
  send: (msg: WsServerMessage) => void,
) => Promise<void>;

export class WebSocketHandler {
  private wss: WebSocketServer;
  private config: WebSocketHandlerConfig;
  private connections = new Set<AuthenticatedConnection>();
  private messageHandler: WsMessageHandler | null = null;

  constructor(config: WebSocketHandlerConfig) {
    this.config = config;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Register a handler for authenticated chat messages */
  onMessage(handler: WsMessageHandler): void {
    this.messageHandler = handler;
  }

  /** Attach to the HTTP server's upgrade event */
  attach(): void {
    this.config.server.on("upgrade", (req, socket, head) => {
      // Check for query parameter auth
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const queryToken = url.searchParams.get("token");

      if (queryToken) {
        // Validate token from query param
        if (!verifyToken(queryToken, this.config.authToken)) {
          // Reject the upgrade by closing the socket
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\n" +
            "Connection: close\r\n" +
            "\r\n",
          );
          socket.destroy();
          return;
        }

        // Token valid -- complete upgrade as pre-authenticated
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleConnection(ws, req, true);
        });
        return;
      }

      // No query token -- upgrade and require auth via first message
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, req, false);
      });
    });
  }

  /** Close all connections and the WebSocket server */
  close(): void {
    for (const conn of this.connections) {
      conn.ws.close(1001, "Server shutting down");
    }
    this.connections.clear();
    this.wss.close();
  }

  private handleConnection(
    ws: WebSocket,
    req: IncomingMessage,
    preAuthenticated: boolean,
  ): void {
    const clientId = req.socket.remoteAddress ?? "unknown";

    const conn: AuthenticatedConnection = {
      ws,
      clientId,
      authenticated: preAuthenticated,
    };

    this.connections.add(conn);

    ws.on("message", (data) => {
      void this.handleMessage(conn, data);
    });

    ws.on("close", () => {
      this.connections.delete(conn);
    });

    ws.on("error", () => {
      this.connections.delete(conn);
    });
  }

  private async handleMessage(
    conn: AuthenticatedConnection,
    data: unknown,
  ): Promise<void> {
    // Parse message
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(String(data)) as WsClientMessage;
    } catch {
      this.sendTo(conn.ws, { type: "error", message: "Invalid JSON" });
      conn.ws.close(4002, "Invalid JSON");
      this.connections.delete(conn);
      return;
    }

    // Require auth as first message if not pre-authenticated
    if (!conn.authenticated) {
      if (msg.type !== "auth") {
        this.sendTo(conn.ws, {
          type: "auth_error",
          reason: "First message must be auth",
        });
        conn.ws.close(4001, "Not authenticated");
        this.connections.delete(conn);
        return;
      }

      if (!verifyToken(msg.token, this.config.authToken)) {
        this.sendTo(conn.ws, {
          type: "auth_error",
          reason: "Invalid token",
        });
        conn.ws.close(4001, "Invalid token");
        this.connections.delete(conn);
        return;
      }

      conn.authenticated = true;
      this.sendTo(conn.ws, { type: "auth_ok" });
      return;
    }

    // Authenticated -- handle message types
    switch (msg.type) {
      case "auth":
        // Already authenticated, ignore re-auth
        this.sendTo(conn.ws, { type: "auth_ok" });
        break;

      case "ping":
        this.sendTo(conn.ws, { type: "pong" });
        break;

      case "chat":
        await this.handleChat(conn, msg.content);
        break;

      default:
        this.sendTo(conn.ws, {
          type: "error",
          message: `Unknown message type`,
        });
    }
  }

  private async handleChat(
    conn: AuthenticatedConnection,
    content: string,
  ): Promise<void> {
    // Rate limit check
    if (!this.config.rateLimiter.check(conn.clientId)) {
      this.sendTo(conn.ws, {
        type: "error",
        message: "Rate limited",
      });
      return;
    }

    if (!this.messageHandler) {
      this.sendTo(conn.ws, {
        type: "error",
        message: "No handler registered",
      });
      return;
    }

    try {
      await this.messageHandler(content, (msg) => this.sendTo(conn.ws, msg));
    } catch (err: unknown) {
      this.sendTo(conn.ws, {
        type: "error",
        message: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  private sendTo(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
```

**Step 2: Run the auth tests**

Run: `npx vitest run packages/gateway/src/ws-handler.test.ts`
Expected: All auth tests PASS

**Step 3: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 4: Commit**

```bash
git add packages/gateway/src/ws-handler.ts
git commit -m "feat(gateway): implement WebSocketHandler with auth and connection management"
```

---

## Task 5: Write failing tests for WebSocketHandler -- chat messages and rate limiting

**Files:**
- Modify: `packages/gateway/src/ws-handler.test.ts`

**Step 1: Add chat and rate limiting test blocks**

Append the following after the existing `describe("WebSocketHandler - auth")` block:

```typescript
describe("WebSocketHandler - chat messages", () => {
  let server: Server;
  let handler: WebSocketHandler;
  let port: number;
  const receivedMessages: Array<{
    content: string;
    sendFn: (msg: WsServerMessage) => void;
  }> = [];

  beforeAll(async () => {
    server = createServer();
    handler = new WebSocketHandler({
      server,
      authToken: AUTH_TOKEN,
      rateLimiter: new RateLimiter(60, 60_000),
    });

    handler.onMessage(async (content, send) => {
      receivedMessages.push({ content, sendFn: send });
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

    // Send chat
    wsSend(ws, { type: "chat", content: "test message" });

    // Collect streaming responses
    const messages: WsServerMessage[] = [];
    messages.push(await wsRecv(ws));
    messages.push(await wsRecv(ws));
    messages.push(await wsRecv(ws));

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
```

**Step 2: Run tests to verify the new ones pass (handler already implemented)**

Run: `npx vitest run packages/gateway/src/ws-handler.test.ts`
Expected: All tests PASS (auth tests from Task 3, plus these new chat/rate-limit tests)

If any fail, debug and fix. The tests are driven by the implementation from Task 4, so they should pass if the handler is correct.

**Step 3: Commit**

```bash
git add packages/gateway/src/ws-handler.test.ts
git commit -m "test(gateway): add WebSocket chat message and rate limiting tests"
```

---

## Task 6: Write failing tests for WebSocketHandler -- connection lifecycle

**Files:**
- Modify: `packages/gateway/src/ws-handler.test.ts`

**Step 1: Add connection lifecycle test block**

Append after the rate limiting `describe` block:

```typescript
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
```

**Step 2: Run tests**

Run: `npx vitest run packages/gateway/src/ws-handler.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add packages/gateway/src/ws-handler.test.ts
git commit -m "test(gateway): add WebSocket connection lifecycle tests"
```

---

## Task 7: Integrate WebSocketHandler into Gateway

**Files:**
- Modify: `packages/gateway/src/server.ts:1-146`

**Step 1: Add WebSocket imports and handler field**

Add import at the top of `packages/gateway/src/server.ts`, after line 8:

```typescript
import { WebSocketHandler, type WsMessageHandler } from "./ws-handler.js";
```

Add a field to the `Gateway` class, after line 21:

```typescript
  private wsHandler: WebSocketHandler | null = null;
  private wsMessageHandler: WsMessageHandler | null = null;
```

**Step 2: Add `onWsMessage()` method**

Add after the existing `onMessage()` method (after line 36):

```typescript
  /** Set the handler for incoming WebSocket chat messages */
  onWsMessage(handler: WsMessageHandler): void {
    this.wsMessageHandler = handler;
  }
```

**Step 3: Create WebSocketHandler in `start()`**

In the `start()` method, after `this.server = server;` (line 58), add:

```typescript
    // Attach WebSocket handler to the same HTTP server
    this.wsHandler = new WebSocketHandler({
      server: this.server,
      authToken: this.config.authToken,
      rateLimiter: this.rateLimiter,
    });

    if (this.wsMessageHandler) {
      this.wsHandler.onMessage(this.wsMessageHandler);
    }

    this.wsHandler.attach();
```

**Step 4: Clean up WebSocket handler in `stop()`**

In the `stop()` method, before `server.close(...)` (line 69), add:

```typescript
    if (this.wsHandler) {
      this.wsHandler.close();
      this.wsHandler = null;
    }
```

**Step 5: Run existing HTTP tests to confirm nothing broke**

Run: `npx vitest run packages/gateway/src/server.test.ts`
Expected: All existing tests PASS

**Step 6: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 7: Commit**

```bash
git add packages/gateway/src/server.ts
git commit -m "feat(gateway): integrate WebSocketHandler into Gateway server lifecycle"
```

---

## Task 8: Write integration test for Gateway with WebSocket

**Files:**
- Modify: `packages/gateway/src/server.test.ts`

**Step 1: Add WebSocket integration tests to `server.test.ts`**

Add these imports at the top:

```typescript
import WebSocket from "ws";
import type { WsClientMessage, WsServerMessage } from "./ws-types.js";
```

Add helpers after the `makeConfig()` function:

```typescript
function wsSend(ws: WebSocket, msg: WsClientMessage): void {
  ws.send(JSON.stringify(msg));
}

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
```

Add a new `describe("WebSocket via Gateway")` block after the existing `describe("stop")` block, inside the outer `describe("Gateway")`:

```typescript
  describe("WebSocket via Gateway", () => {
    let gateway: Gateway;
    let baseUrl: string;

    beforeAll(async () => {
      gateway = new Gateway(makeConfig());

      // Set up HTTP handler (existing)
      gateway.onMessage(async (msg) => {
        if (msg.type === "ping") {
          return { type: "pong", payload: null } satisfies GatewayResponse;
        }
        return {
          type: "response",
          payload: { echo: msg.payload },
        } satisfies GatewayResponse;
      });

      // Set up WebSocket handler
      gateway.onWsMessage(async (content, send) => {
        send({ type: "text_delta", content: `Echo: ${content}` });
        send({
          type: "done",
          response: {
            message: `Echo: ${content}`,
            toolCallsMade: 0,
            model: "test",
          },
        });
      });

      await gateway.start();
      const config = (gateway as unknown as { config: GatewayConfig }).config;
      baseUrl = `ws://127.0.0.1:${String(config.port)}`;
    });

    afterAll(async () => {
      await gateway.stop();
    });

    it("WebSocket and HTTP work on the same port", async () => {
      // Test HTTP still works
      const config = (gateway as unknown as { config: GatewayConfig }).config;
      const httpRes = await fetch(
        `http://127.0.0.1:${String(config.port)}/api/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${AUTH_TOKEN}`,
          },
          body: JSON.stringify({ type: "ping", payload: null }),
        },
      );
      expect(httpRes.status).toBe(200);

      // Test WebSocket works
      const ws = new WebSocket(baseUrl);
      await wsOpen(ws);

      wsSend(ws, { type: "auth", token: AUTH_TOKEN });
      const authReply = await wsRecv(ws);
      expect(authReply.type).toBe("auth_ok");

      wsSend(ws, { type: "chat", content: "hello" });
      const delta = await wsRecv(ws);
      expect(delta).toEqual({ type: "text_delta", content: "Echo: hello" });

      const done = await wsRecv(ws);
      expect(done.type).toBe("done");

      ws.close();
    });

    it("stop() cleans up WebSocket connections", async () => {
      const gw2 = new Gateway(makeConfig());
      gw2.onWsMessage(async (_content, send) => {
        send({
          type: "done",
          response: { message: "ok", toolCallsMade: 0, model: "test" },
        });
      });
      await gw2.start();

      const config2 = (gw2 as unknown as { config: GatewayConfig }).config;
      const ws = new WebSocket(`ws://127.0.0.1:${String(config2.port)}`);
      await wsOpen(ws);

      wsSend(ws, { type: "auth", token: AUTH_TOKEN });
      await wsRecv(ws);

      // Stop the gateway
      await gw2.stop();
      expect(gw2.isRunning).toBe(false);
    });
  });
```

**Step 2: Run the tests**

Run: `npx vitest run packages/gateway/src/server.test.ts`
Expected: All tests PASS (both existing HTTP tests and new WebSocket tests)

**Step 3: Commit**

```bash
git add packages/gateway/src/server.test.ts
git commit -m "test(gateway): add Gateway WebSocket integration tests"
```

---

## Task 9: Update barrel exports

**Files:**
- Modify: `packages/gateway/src/index.ts:1-5`

**Step 1: Add WebSocket exports**

Update `packages/gateway/src/index.ts` to:

```typescript
export { Gateway } from "./server.js";
export { validateAuthToken, verifyToken, AuthError } from "./auth.js";
export { RateLimiter } from "./rate-limit.js";
export { WebSocketHandler } from "./ws-handler.js";
export { DEFAULT_GATEWAY_CONFIG, MIN_TOKEN_LENGTH } from "./types.js";
export type { GatewayConfig, GatewayMessage, GatewayResponse } from "./types.js";
export type { WsMessageHandler, WebSocketHandlerConfig } from "./ws-handler.js";
export type {
  WsClientMessage,
  WsServerMessage,
  WsAuthMessage,
  WsChatMessage,
  WsPingMessage,
  WsAuthOkMessage,
  WsAuthErrorMessage,
  WsTextDeltaMessage,
  WsToolStartMessage,
  WsToolResultMessage,
  WsDoneMessage,
  WsErrorMessage,
  WsPongMessage,
} from "./ws-types.js";
```

**Step 2: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 3: Commit**

```bash
git add packages/gateway/src/index.ts
git commit -m "feat(gateway): export WebSocket types and handler from barrel"
```

---

## Task 10: Update CLI server wiring for WebSocket streaming

**Files:**
- Modify: `packages/cli/src/cli.ts:105-167`

This task wires the gateway's WebSocket handler to the agent's `processMessageStream()` method (from the streaming plan). The WebSocket handler receives chat content and streams `AgentStreamEvent` objects back as `WsServerMessage` frames.

**Note:** This task depends on the streaming plan (Task 1-3 from `2026-03-03-streaming-responses.md`) being implemented first. If `processMessageStream()` does not yet exist, wire it to the existing `processMessage()` instead and convert the response to a single `done` event.

**Step 1: Add WebSocket handler wiring in `runServe()`**

In `packages/cli/src/cli.ts`, after the existing `gateway.onMessage(...)` block (after line 135) and before `await gateway.start()` (line 144), add:

```typescript
  // Wire WebSocket handler for streaming responses
  gateway.onWsMessage(async (content, send) => {
    const peer = { channelId: "gateway-ws", peerId: "ws-client" };
    const session = sessionManager.getOrCreate(peer);

    // If processMessageStream is available, use it for streaming
    if ("processMessageStream" in agent) {
      const stream = agent.processMessageStream(session, content);
      for await (const event of stream) {
        switch (event.type) {
          case "text_delta":
            send({ type: "text_delta", content: event.content });
            break;
          case "tool_start":
            send({
              type: "tool_start",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
            });
            break;
          case "tool_result":
            send({
              type: "tool_result",
              toolCallId: event.toolCallId,
              result: event.result,
              success: event.success,
            });
            break;
          case "done":
            send({ type: "done", response: event.response });
            break;
          case "error":
            send({ type: "error", message: event.error });
            break;
        }
      }
    } else {
      // Fallback: use non-streaming processMessage
      const response = await agent.processMessage(session, content);
      send({
        type: "done",
        response: {
          message: response.message,
          toolCallsMade: response.toolCallsMade,
          model: response.model,
        },
      });
    }
  });
```

**Step 2: Update the startup output**

After the existing `Gateway API:` line (line 149), add:

```typescript
  process.stdout.write(
    `  WebSocket:    ws://${DEFAULT_GATEWAY_CONFIG.host}:${DEFAULT_GATEWAY_CONFIG.port}/\n`,
  );
```

**Step 3: Type-check**

Run: `npx tsc --build --dry`
Expected: Clean

**Step 4: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): wire WebSocket gateway handler to agent streaming"
```

---

## Task 11: Full verification pass

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Run linter**

Run: `pnpm lint`
Expected: Clean

**Step 3: Run type-check**

Run: `pnpm typecheck`
Expected: Clean

**Step 4: If any failures, fix them and commit**

```bash
git add -A
git commit -m "fix(gateway): address test/lint issues from WebSocket implementation"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add `ws` dependency | `packages/gateway/package.json` |
| 2 | Define WebSocket message protocol types | `packages/gateway/src/ws-types.ts` |
| 3 | Write failing auth tests | `packages/gateway/src/ws-handler.test.ts` |
| 4 | Implement `WebSocketHandler` | `packages/gateway/src/ws-handler.ts` |
| 5 | Add chat and rate limiting tests | `packages/gateway/src/ws-handler.test.ts` |
| 6 | Add connection lifecycle tests | `packages/gateway/src/ws-handler.test.ts` |
| 7 | Integrate into `Gateway` | `packages/gateway/src/server.ts` |
| 8 | Gateway + WebSocket integration tests | `packages/gateway/src/server.test.ts` |
| 9 | Update barrel exports | `packages/gateway/src/index.ts` |
| 10 | Wire CLI server for WS streaming | `packages/cli/src/cli.ts` |
| 11 | Full verification pass | All |

**Dependency note:** Task 10 references `processMessageStream()` from the streaming plan (`2026-03-03-streaming-responses.md`). If that plan hasn't been implemented yet, the fallback path in Task 10 uses the existing `processMessage()` and wraps the result in a single `done` event.

**Not in scope (future work):**
- WebSocket binary message support (only JSON text frames)
- Per-connection session persistence (currently creates new session per WS connection)
- WebSocket compression (`permessage-deflate`)
- Reconnection protocol / session resumption
- WebChat adapter WebSocket integration (currently uses SSE)
- Heartbeat / idle timeout for stale connections
