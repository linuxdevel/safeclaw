import type { CopilotModel } from "../copilot/types.js";

export interface AgentConfig {
  model: CopilotModel;
  systemPrompt: string;
  maxToolRounds: number;
  skillId: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  maxContextTokens?: number | undefined;
}

export interface AgentResponse {
  message: string;
  toolCallsMade: number;
  model: CopilotModel;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: "claude-sonnet-4",
  systemPrompt:
    "You are SafeClaw, a secure AI assistant. Follow user instructions carefully.",
  maxToolRounds: 10,
  skillId: "builtin",
  temperature: undefined,
  maxTokens: undefined,
  maxContextTokens: 100_000,
};

// --- Streaming event types ---

export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  result: string;
  success: boolean;
}

export interface DoneEvent {
  type: "done";
  response: AgentResponse;
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export type AgentStreamEvent =
  | TextDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | DoneEvent
  | ErrorEvent;
