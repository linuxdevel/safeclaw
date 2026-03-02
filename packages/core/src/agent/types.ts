import type { CopilotModel } from "../copilot/types.js";

export interface AgentConfig {
  model: CopilotModel;
  systemPrompt: string;
  maxToolRounds: number;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
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
  temperature: undefined,
  maxTokens: undefined,
};
