export interface CopilotAuthConfig {
  /** GitHub OAuth client ID for device flow */
  clientId: string;
  /** OAuth scopes needed */
  scopes: string[];
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface CopilotToken {
  token: string;
  expiresAt: number; // Unix timestamp ms
}

/**
 * Model identifier accepted by the Copilot API.
 *
 * Widened to `string` to support dynamically discovered models
 * from the models.dev registry. Well-known defaults are listed
 * as a convenience union but any valid model ID string is accepted.
 */
export type CopilotModel = string;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string | undefined;
  tool_calls?: ToolCall[] | undefined;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinitionParam {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: CopilotModel;
  messages: ChatMessage[];
  tools?: ToolDefinitionParam[] | undefined;
  tool_choice?: "auto" | "none" | undefined;
  stream?: boolean | undefined;
  max_tokens?: number | undefined;
  temperature?: number | undefined;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "tool_calls" | "length";
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamDelta {
  role?: string | undefined;
  content?: string | undefined;
  tool_calls?:
    | Array<{
        index: number;
        id?: string | undefined;
        type?: string | undefined;
        function?:
          | {
              name?: string | undefined;
              arguments?: string | undefined;
            }
          | undefined;
      }>
    | undefined;
}

export interface StreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
}

export const DEFAULT_MODEL: CopilotModel = "claude-sonnet-4";

export const COPILOT_API_BASE = "https://api.githubcopilot.com";
export const GITHUB_DEVICE_AUTH_URL =
  "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
