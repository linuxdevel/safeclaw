import { readFileSync } from "node:fs";
import type { ToolHandler } from "../types.js";

export const readTool: ToolHandler = {
  name: "read",
  description: "Read a file's contents with optional offset and line limit",
  requiredCapabilities: ["fs:read"],

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args["path"];
    if (typeof path !== "string") {
      throw new Error("Required argument 'path' must be a string");
    }
    if (!path.startsWith("/")) {
      throw new Error("Path must be absolute (start with '/')");
    }

    const offset =
      args["offset"] !== undefined ? Number(args["offset"]) : 1;
    if (Number.isNaN(offset)) {
      throw new Error("'offset' must be a number");
    }
    if (offset < 1) {
      throw new Error("'offset' must be >= 1");
    }

    const limit =
      args["limit"] !== undefined ? Number(args["limit"]) : undefined;
    if (limit !== undefined && Number.isNaN(limit)) {
      throw new Error("'limit' must be a number");
    }
    if (limit !== undefined && limit < 1) {
      throw new Error("'limit' must be >= 1");
    }

    const content = readFileSync(path, "utf-8");
    if (content === "") {
      return "";
    }

    const allLines = content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n");

    // offset is 1-indexed
    const startIndex = Math.max(0, offset - 1);
    const sliced =
      limit !== undefined
        ? allLines.slice(startIndex, startIndex + limit)
        : allLines.slice(startIndex);

    return sliced
      .map((line: string, i: number) => `${startIndex + i + 1}: ${line}`)
      .join("\n");
  },
};
