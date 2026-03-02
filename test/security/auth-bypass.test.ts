import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Gateway, AuthError } from "@safeclaw/gateway";
import type { GatewayConfig, GatewayResponse } from "@safeclaw/gateway";

const AUTH_TOKEN = "secure-test-token-that-is-long-enough-for-validation";

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    rateLimit: { maxRequests: 5, windowMs: 60_000 },
    ...overrides,
  };
}

describe("Auth bypass prevention", () => {
  describe("Gateway construction rejects insecure tokens", () => {
    it("refuses construction with short token (< 32 chars)", () => {
      expect(() => new Gateway(makeConfig({ authToken: "short" }))).toThrow(
        AuthError,
      );
      expect(() => new Gateway(makeConfig({ authToken: "short" }))).toThrow(
        /at least 32 characters/,
      );
    });

    it("refuses construction with empty token", () => {
      expect(() => new Gateway(makeConfig({ authToken: "" }))).toThrow(
        AuthError,
      );
    });

    it("refuses construction with 31-char token (boundary)", () => {
      expect(
        () => new Gateway(makeConfig({ authToken: "a".repeat(31) })),
      ).toThrow(AuthError);
    });

    it("accepts construction with exactly 32-char token", () => {
      expect(
        () => new Gateway(makeConfig({ authToken: "a".repeat(32) })),
      ).not.toThrow();
    });

    it("cannot be started in 'no auth' mode — there is no such config option", () => {
      // GatewayConfig requires authToken as a mandatory field.
      // Passing undefined or omitting it is a type error.
      // At runtime, empty string is rejected.
      expect(() => new Gateway(makeConfig({ authToken: "" }))).toThrow(
        AuthError,
      );
    });
  });

  describe("HTTP request auth enforcement", () => {
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

      const config = (gateway as unknown as { config: GatewayConfig }).config;
      baseUrl = `http://127.0.0.1:${String(config.port)}`;
    });

    afterAll(async () => {
      await gateway.stop();
    });

    it("returns 401 for requests without Authorization header", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "ping", payload: null }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for requests with wrong token", async () => {
      const wrongToken = "x".repeat(AUTH_TOKEN.length);
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${wrongToken}`,
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for Bearer prefix with wrong value", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer completely-wrong-token-value-here!!",
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header has no Bearer prefix", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: AUTH_TOKEN,
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with correct token", async () => {
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
  });

  describe("Rate limiting", () => {
    let rlGateway: Gateway;
    let rlUrl: string;

    beforeAll(async () => {
      rlGateway = new Gateway(
        makeConfig({ rateLimit: { maxRequests: 3, windowMs: 60_000 } }),
      );
      rlGateway.onMessage(async () => ({
        type: "pong" as const,
        payload: null,
      }));
      await rlGateway.start();

      const config = (rlGateway as unknown as { config: GatewayConfig }).config;
      rlUrl = `http://127.0.0.1:${String(config.port)}`;
    });

    afterAll(async () => {
      await rlGateway.stop();
    });

    it("returns 429 after maxRequests exceeded", async () => {
      const makeRequest = () =>
        fetch(`${rlUrl}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${AUTH_TOKEN}`,
          },
          body: JSON.stringify({ type: "ping", payload: null }),
        });

      // First 3 should succeed (maxRequests: 3)
      const res1 = await makeRequest();
      expect(res1.status).toBe(200);
      const res2 = await makeRequest();
      expect(res2.status).toBe(200);
      const res3 = await makeRequest();
      expect(res3.status).toBe(200);

      // Fourth should be rate limited
      const res4 = await makeRequest();
      expect(res4.status).toBe(429);
    });

    it("auth check happens before rate limit — invalid token still gets 401", async () => {
      // Even if rate limited, an invalid token should get 401 not 429
      // because auth is checked before rate limiting in the handler
      const res = await fetch(`${rlUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token-value-that-is-invalid",
        },
        body: JSON.stringify({ type: "ping", payload: null }),
      });
      expect(res.status).toBe(401);
    });
  });
});
