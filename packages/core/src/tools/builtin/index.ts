import type { ToolHandler } from "../types.js";
import type { ProcessManager } from "../process-manager.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { webFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createProcessTool } from "./process.js";

export { readTool, writeTool, editTool, bashTool, webFetchTool };
export { createWebSearchTool } from "./web-search.js";
export { createProcessTool } from "./process.js";

export interface BuiltinToolsOptions {
  braveApiKey?: string | undefined;
  processManager?: ProcessManager | undefined;
}

/** Creates an array of all built-in tool handlers. */
export function createBuiltinTools(options?: BuiltinToolsOptions): ToolHandler[] {
  const tools: ToolHandler[] = [readTool, writeTool, editTool, bashTool, webFetchTool];

  if (options?.braveApiKey) {
    tools.push(createWebSearchTool(options.braveApiKey));
  }

  if (options?.processManager) {
    tools.push(createProcessTool(options.processManager));
  }

  return tools;
}
