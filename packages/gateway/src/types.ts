export interface GatewayConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to */
  host: string;
  /** Authentication token (mandatory, minimum 32 chars) */
  authToken: string;
  /** Rate limit: max requests per window */
  rateLimit: { maxRequests: number; windowMs: number };
}

export interface GatewayMessage {
  type: "chat" | "ping" | "config";
  payload: unknown;
}

export interface GatewayResponse {
  type: "response" | "error" | "pong";
  payload: unknown;
}

export const DEFAULT_GATEWAY_CONFIG: Omit<GatewayConfig, "authToken"> = {
  port: 18789,
  host: "127.0.0.1",
  rateLimit: { maxRequests: 60, windowMs: 60_000 },
};

/** Minimum token length for security */
export const MIN_TOKEN_LENGTH = 32;
