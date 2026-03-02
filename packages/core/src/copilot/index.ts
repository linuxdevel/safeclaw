export { requestDeviceCode, pollForToken, getCopilotToken } from "./auth.js";
export { CopilotClient } from "./client.js";
export { DEFAULT_MODEL, COPILOT_API_BASE } from "./types.js";
export type {
  CopilotAuthConfig,
  DeviceCodeResponse,
  TokenResponse,
  CopilotToken,
  CopilotModel,
  ChatMessage,
  ToolCall,
  ToolDefinitionParam,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  StreamDelta,
  StreamChunk,
} from "./types.js";
