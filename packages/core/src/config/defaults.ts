import type { SafeClawConfig } from "./types.js";

/**
 * Default configuration values.
 * These match the existing hardcoded defaults across the codebase:
 * - model/systemPrompt/maxToolRounds: packages/core/src/agent/types.ts
 * - gateway host/port: packages/gateway/src/types.ts
 * - sandbox timeout: packages/sandbox/src/types.ts
 */
export const DEFAULT_CONFIG: Required<
  Pick<SafeClawConfig, "model" | "systemPrompt" | "maxToolRounds">
> &
  SafeClawConfig = {
  model: "claude-sonnet-4",
  systemPrompt:
    "You are SafeClaw, a secure AI assistant. Follow user instructions carefully.",
  maxToolRounds: 10,
  temperature: undefined,
  maxTokens: undefined,
  maxContextTokens: 100_000,
  gateway: {
    host: "127.0.0.1",
    port: 18789,
  },
  sandbox: {
    enabled: true,
    timeout: 30_000,
  },
};
