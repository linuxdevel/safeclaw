import { readFileSync, writeFileSync } from "node:fs";
import type { ToolHandler } from "../types.js";

export const editTool: ToolHandler = {
  name: "edit",
  description:
    "Apply a string replacement to a file. Validates the old string exists and is unique unless replaceAll is set.",
  requiredCapabilities: ["fs:read", "fs:write"],

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args["path"];
    if (typeof path !== "string") {
      throw new Error("Required argument 'path' must be a string");
    }
    if (!path.startsWith("/")) {
      throw new Error("Path must be absolute (start with '/')");
    }

    const oldString = args["oldString"];
    if (typeof oldString !== "string") {
      throw new Error("Required argument 'oldString' must be a string");
    }

    const newString = args["newString"];
    if (typeof newString !== "string") {
      throw new Error("Required argument 'newString' must be a string");
    }

    if (oldString === newString) {
      throw new Error("oldString and newString must be different");
    }

    const replaceAll = args["replaceAll"] === true;

    const content = readFileSync(path, "utf-8");

    // Count occurrences
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldString, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + oldString.length;
    }

    if (count === 0) {
      throw new Error("oldString not found in file content");
    }

    if (count > 1 && !replaceAll) {
      throw new Error(
        `Found multiple matches (${count}) for oldString. Use replaceAll to replace all occurrences.`,
      );
    }

    let updated: string;
    if (replaceAll) {
      updated = content.split(oldString).join(newString);
    } else {
      updated = content.replace(oldString, newString);
    }

    writeFileSync(path, updated, "utf-8");

    return `Applied edit to ${path}. Replaced ${count} occurrence${count > 1 ? "s" : ""}.`;
  },
};
