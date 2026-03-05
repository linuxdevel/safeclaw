import type { SafeClawConfig } from "./types.js";

const ALLOWED_TOP_KEYS = new Set([
  "model",
  "systemPrompt",
  "maxToolRounds",
  "temperature",
  "maxTokens",
  "maxContextTokens",
  "gateway",
  "sandbox",
]);

const ALLOWED_GATEWAY_KEYS = new Set(["host", "port"]);
const ALLOWED_SANDBOX_KEYS = new Set(["enabled", "timeout"]);

/**
 * Validates a parsed JSON value against the SafeClawConfig schema.
 * Throws a descriptive error on invalid input (fail-closed).
 * Returns the value typed as SafeClawConfig on success.
 */
export function validateConfig(value: unknown): SafeClawConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Config must be a JSON object");
  }

  const obj = value as Record<string, unknown>;

  // Reject unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`Unknown config key: "${key}"`);
    }
  }

  // model
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.length === 0) {
      throw new Error('"model" must be a non-empty string');
    }
  }

  // systemPrompt
  if (obj.systemPrompt !== undefined) {
    if (typeof obj.systemPrompt !== "string") {
      throw new Error('"systemPrompt" must be a string');
    }
  }

  // maxToolRounds
  if (obj.maxToolRounds !== undefined) {
    if (
      typeof obj.maxToolRounds !== "number" ||
      !Number.isInteger(obj.maxToolRounds) ||
      obj.maxToolRounds < 1
    ) {
      throw new Error('"maxToolRounds" must be a positive integer');
    }
  }

  // temperature
  if (obj.temperature !== undefined) {
    if (
      typeof obj.temperature !== "number" ||
      obj.temperature < 0 ||
      obj.temperature > 2
    ) {
      throw new Error('"temperature" must be a number between 0 and 2');
    }
  }

  // maxTokens
  if (obj.maxTokens !== undefined) {
    if (
      typeof obj.maxTokens !== "number" ||
      !Number.isInteger(obj.maxTokens) ||
      obj.maxTokens < 1
    ) {
      throw new Error('"maxTokens" must be a positive integer');
    }
  }

  // maxContextTokens
  if (obj.maxContextTokens !== undefined) {
    if (
      typeof obj.maxContextTokens !== "number" ||
      !Number.isInteger(obj.maxContextTokens) ||
      obj.maxContextTokens < 1
    ) {
      throw new Error('"maxContextTokens" must be a positive integer');
    }
  }

  // gateway
  if (obj.gateway !== undefined) {
    if (
      typeof obj.gateway !== "object" ||
      obj.gateway === null ||
      Array.isArray(obj.gateway)
    ) {
      throw new Error('"gateway" must be an object');
    }
    const gw = obj.gateway as Record<string, unknown>;
    for (const key of Object.keys(gw)) {
      if (!ALLOWED_GATEWAY_KEYS.has(key)) {
        throw new Error(`Unknown gateway key: "${key}"`);
      }
    }
    if (gw.host !== undefined) {
      if (typeof gw.host !== "string" || gw.host.length === 0) {
        throw new Error('"gateway.host" must be a non-empty string');
      }
    }
    if (gw.port !== undefined) {
      if (
        typeof gw.port !== "number" ||
        !Number.isInteger(gw.port) ||
        gw.port < 1 ||
        gw.port > 65535
      ) {
        throw new Error(
          '"gateway.port" must be an integer between 1 and 65535',
        );
      }
    }
  }

  // sandbox
  if (obj.sandbox !== undefined) {
    if (
      typeof obj.sandbox !== "object" ||
      obj.sandbox === null ||
      Array.isArray(obj.sandbox)
    ) {
      throw new Error('"sandbox" must be an object');
    }
    const sb = obj.sandbox as Record<string, unknown>;
    for (const key of Object.keys(sb)) {
      if (!ALLOWED_SANDBOX_KEYS.has(key)) {
        throw new Error(`Unknown sandbox key: "${key}"`);
      }
    }
    if (sb.enabled !== undefined) {
      if (typeof sb.enabled !== "boolean") {
        throw new Error('"sandbox.enabled" must be a boolean');
      }
    }
    if (sb.timeout !== undefined) {
      if (
        typeof sb.timeout !== "number" ||
        !Number.isInteger(sb.timeout) ||
        sb.timeout < 1
      ) {
        throw new Error('"sandbox.timeout" must be a positive integer');
      }
    }
  }

  return obj as SafeClawConfig;
}
