import { timingSafeEqual } from "node:crypto";
import { MIN_TOKEN_LENGTH } from "./types.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Validate that a config token meets minimum security requirements.
 * Called at startup — refuse to start if token is insecure.
 */
export function validateAuthToken(token: string): void {
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new AuthError(
      `Auth token must be at least ${MIN_TOKEN_LENGTH} characters. ` +
        `SafeClaw requires mandatory authentication — there is no "none" mode.`,
    );
  }
}

/**
 * Verify a request token against the configured token.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return timingSafeEqual(a, b);
}
