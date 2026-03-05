/**
 * Plain-text configuration for non-secret settings.
 * Loaded from ~/.safeclaw/safeclaw.json.
 * All fields are optional — defaults are applied by the loader.
 */
export interface SafeClawConfig {
  /** LLM model identifier (e.g. "claude-sonnet-4") */
  model?: string | undefined;
  /** System prompt for the agent */
  systemPrompt?: string | undefined;
  /** Maximum number of tool-calling rounds per message */
  maxToolRounds?: number | undefined;
  /** LLM temperature (0.0 – 2.0) */
  temperature?: number | undefined;
  /** Maximum tokens in LLM response */
  maxTokens?: number | undefined;
  /** Maximum context tokens before compaction triggers (default: 100000) */
  maxContextTokens?: number | undefined;
  /** Gateway server settings */
  gateway?: GatewayFileConfig | undefined;
  /** Sandbox settings */
  sandbox?: SandboxFileConfig | undefined;
}

export interface GatewayFileConfig {
  /** Host to bind to (default: "127.0.0.1") */
  host?: string | undefined;
  /** Port to listen on (default: 18789) */
  port?: number | undefined;
}

export interface SandboxFileConfig {
  /** Whether sandboxing is enabled (default: true) */
  enabled?: boolean | undefined;
  /** Sandbox timeout in milliseconds (default: 30000) */
  timeout?: number | undefined;
}
