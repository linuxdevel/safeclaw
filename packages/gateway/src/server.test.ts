import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { Gateway } from "./server.js";
import type { GatewayConfig, GatewayResponse } from "./types.js";
import type { WsClientMessage, WsServerMessage } from "./ws-types.js";

const AUTH_TOKEN = "a]3Fk9!mP#nQ7wR$xY2zB&cD5eH8jL0v";

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    rateLimit: { maxRequests: 60, windowMs: 60_000 },
    ...overrides,
  };
}

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

describe("Gateway", () => {
  describe("constructor", () => {
    it("rejects config with short auth token", () => {
      expect(() => makeConfig({ authToken: "short" }) && new Gateway(makeConfig({ authToken: "short" }))).toThrow(
        /at least 32 characters/,
      );
    });

    it("accepts config with valid auth token", () => {
      expect(() => new Gateway(makeConfig())).not.toThrow();
    });
  });

  describe("HTTP server", () => {
    let gateway: Gateway;
    let baseUrl: string;

    beforeAll(async () => {
      gateway = new Gateway(makeConfig());
      gateway.onMessage(async (msg) => {
        if (msg.type === "ping") {
          return { type: "pong", payload: null } satisfies GatewayResponse;
        }
        return {
          type: "response",
          payload: { echo: msg.payload },
        } satisfies GatewayResponse;
      });
      await gateway.start();
      // Access the assigned port via a second start being no-op
      // We need to get the port from the config (updated after start)
      // Using a small trick: read the private config
      const config = (gateway as unknown as { config: GatewayConfig }).config;
      baseUrl = `http://127.0.0.1:${String(config.port)}`;
    });

    afterAll(async () => {
      await gateway.stop();
    });

    it("start/stop lifecycle works", () => {
      expect(gateway.isRunning).toBe(true);
    });

    it("rejects requests without auth header (401)", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "ping", payload: null }),
      });

      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong auth token (401)", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${"x".repeat(34)}`,
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });

      expect(res.status).toBe(401);
    });

    it("accepts requests with correct auth token", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as GatewayResponse;
      expect(body.type).toBe("pong");
    });

    it("handles chat messages via messageHandler", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ type: "chat", payload: "hello" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as GatewayResponse;
      expect(body.type).toBe("response");
      expect(body.payload).toEqual({ echo: "hello" });
    });

    it("returns 404 for non-POST requests", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for wrong path", async () => {
      const res = await fetch(`${baseUrl}/wrong-path`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });

      expect(res.status).toBe(404);
    });

    it("rate limits requests (429 after limit exceeded)", async () => {
      // Create a separate gateway with low rate limit
      const rlGateway = new Gateway(
        makeConfig({ rateLimit: { maxRequests: 2, windowMs: 60_000 } }),
      );
      rlGateway.onMessage(async () => ({
        type: "pong" as const,
        payload: null,
      }));
      await rlGateway.start();
      const rlConfig = (rlGateway as unknown as { config: GatewayConfig })
        .config;
      const rlUrl = `http://127.0.0.1:${String(rlConfig.port)}`;

      try {
        const makeRequest = () =>
          fetch(`${rlUrl}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify({ type: "ping", payload: null }),
          });

        // First two should succeed
        const res1 = await makeRequest();
        expect(res1.status).toBe(200);
        const res2 = await makeRequest();
        expect(res2.status).toBe(200);

        // Third should be rate limited
        const res3 = await makeRequest();
        expect(res3.status).toBe(429);
      } finally {
        await rlGateway.stop();
      }
    });
  });

  describe("stop", () => {
    it("stop on non-running gateway is a no-op", async () => {
      const gw = new Gateway(makeConfig());
      await expect(gw.stop()).resolves.toBeUndefined();
      expect(gw.isRunning).toBe(false);
    });
  });

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

      // Set up collection BEFORE sending chat to avoid race
      const messagesPromise = wsRecvN(ws, 2);

      wsSend(ws, { type: "chat", content: "hello" });
      const messages = await messagesPromise;

      expect(messages[0]).toEqual({
        type: "text_delta",
        content: "Echo: hello",
      });
      expect(messages[1]!.type).toBe("done");

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
});
