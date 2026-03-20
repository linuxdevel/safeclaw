import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestDeviceCode, pollForToken, getCopilotToken } from "./auth.js";
import {
  GITHUB_DEVICE_AUTH_URL,
  GITHUB_TOKEN_URL,
  COPILOT_TOKEN_URL,
} from "./types.js";
import type { CopilotAuthConfig } from "./types.js";

const config: CopilotAuthConfig = {
  clientId: "test-client-id",
  scopes: ["copilot", "read:user"],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  } as Response;
}

describe("requestDeviceCode", () => {
  it("sends correct POST and returns parsed response", async () => {
    const deviceResponse = {
      device_code: "dc_123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(deviceResponse));

    const result = await requestDeviceCode(config);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(GITHUB_DEVICE_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: "test-client-id",
        scope: "copilot read:user",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual(deviceResponse);
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(requestDeviceCode(config)).rejects.toThrow(
      "Device code request failed: 401",
    );
  });
});

describe("pollForToken", () => {
  it("polls until token received", async () => {
    const tokenResponse = {
      access_token: "gho_abc123",
      token_type: "bearer",
      scope: "copilot read:user",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenResponse));

    const result = await pollForToken(config, "dc_123", 5);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: "test-client-id",
        device_code: "dc_123",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual(tokenResponse);
  });

  it("handles authorization_pending by retrying", async () => {
    vi.useFakeTimers();

    const pending = { error: "authorization_pending" };
    const tokenResponse = {
      access_token: "gho_abc123",
      token_type: "bearer",
      scope: "copilot",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(pending))
      .mockResolvedValueOnce(jsonResponse(tokenResponse));

    const promise = pollForToken(config, "dc_123", 1);

    // Advance past the 1-second delay
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(tokenResponse);

    vi.useRealTimers();
  });

  it("handles slow_down by increasing interval and retrying", async () => {
    vi.useFakeTimers();

    const slowDown = { error: "slow_down" };
    const tokenResponse = {
      access_token: "gho_abc123",
      token_type: "bearer",
      scope: "copilot",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(slowDown))
      .mockResolvedValueOnce(jsonResponse(tokenResponse));

    const promise = pollForToken(config, "dc_123", 5);

    // slow_down increases interval from 5 to 10; advance past the 10-second delay
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(tokenResponse);

    vi.useRealTimers();
  });

  it("throws on non-pending errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "access_denied" }),
    );

    await expect(pollForToken(config, "dc_123", 5)).rejects.toThrow(
      "Token poll error: access_denied",
    );
  });
});

describe("getCopilotToken", () => {
  it("exchanges GitHub token for Copilot token", async () => {
    const copilotData = {
      token: "tid=copilot_token_xyz",
      expires_at: 1700000000,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(copilotData));

    const result = await getCopilotToken("gho_abc123");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: {
        Authorization: "token gho_abc123",
        Accept: "application/json",
      },
    });
    expect(result).toEqual({
      token: "tid=copilot_token_xyz",
      expiresAt: 1700000000000,
    });
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));

    await expect(getCopilotToken("bad_token")).rejects.toThrow(
      "Copilot token request failed: 403",
    );
  });
});
