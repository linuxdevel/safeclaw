import type { SandboxPolicy, SandboxResult } from "@safeclaw/sandbox";
import type { Capability } from "../capabilities/types.js";

// Re-export to prevent unused import lint errors; these types
// are part of the public API surface that downstream consumers use.
export type { SandboxPolicy, SandboxResult };

export interface ToolExecutionRequest {
  /** Which skill is requesting the tool execution */
  skillId: string;
  /** Tool name */
  toolName: string;
  /** Tool arguments (JSON-parsed from LLM) */
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  durationMs: number;
  sandboxed: boolean;
}

export interface ToolHandler {
  name: string;
  description: string;
  requiredCapabilities: Capability[];
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ToolRegistry {
  register(handler: ToolHandler): void;
  get(name: string): ToolHandler | undefined;
  list(): ToolHandler[];
}
