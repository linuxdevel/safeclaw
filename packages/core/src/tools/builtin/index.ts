import type { ToolHandler } from "../types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { webFetchTool } from "./web-fetch.js";

export { readTool } from "./read.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { bashTool } from "./bash.js";
export { webFetchTool } from "./web-fetch.js";

/** Creates an array of all built-in tool handlers. */
export function createBuiltinTools(): ToolHandler[] {
  return [readTool, writeTool, editTool, bashTool, webFetchTool];
}
