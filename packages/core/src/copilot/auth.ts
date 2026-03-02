import type {
  CopilotAuthConfig,
  CopilotToken,
  DeviceCodeResponse,
  TokenResponse,
} from "./types.js";
import {
  COPILOT_TOKEN_URL,
  GITHUB_DEVICE_AUTH_URL,
  GITHUB_TOKEN_URL,
} from "./types.js";

/**
 * Initiate GitHub Device Flow by requesting a device code.
 * The user must visit the verification_uri and enter the user_code.
 */
export async function requestDeviceCode(
  config: CopilotAuthConfig,
): Promise<DeviceCodeResponse> {
  const response = await fetch(GITHUB_DEVICE_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Device code request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Poll GitHub for the OAuth token after the user has authorized the device.
 * Retries on "authorization_pending" errors, respecting the given interval.
 */
export async function pollForToken(
  config: CopilotAuthConfig,
  deviceCode: string,
  interval: number,
): Promise<TokenResponse> {
  for (;;) {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Token poll failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as
      | TokenResponse
      | { error: string };

    if ("error" in data) {
      if (data.error === "authorization_pending") {
        await delay(interval * 1000);
        continue;
      }
      throw new Error(`Token poll error: ${data.error}`);
    }

    return data;
  }
}

/**
 * Exchange a GitHub OAuth token for a short-lived Copilot API token.
 */
export async function getCopilotToken(
  githubToken: string,
): Promise<CopilotToken> {
  const response = await fetch(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Copilot token request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    token: string;
    expires_at: number;
  };

  return {
    token: data.token,
    expiresAt: data.expires_at * 1000, // Convert to ms
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
