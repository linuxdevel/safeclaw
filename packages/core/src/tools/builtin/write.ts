import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolHandler } from "../types.js";

export const writeTool: ToolHandler = {
  name: "write",
  description: "Write content to a file, creating parent directories if needed",
  requiredCapabilities: ["fs:write"],

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args["path"];
    if (typeof path !== "string") {
      throw new Error("Required argument 'path' must be a string");
    }
    if (!path.startsWith("/")) {
      throw new Error("Path must be absolute (start with '/')");
    }

    const content = args["content"];
    if (typeof content !== "string") {
      throw new Error("Required argument 'content' must be a string");
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf-8");

    return `Wrote ${content.length} bytes to ${path}`;
  },
};
