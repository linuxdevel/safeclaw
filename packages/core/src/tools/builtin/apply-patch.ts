import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import type { ToolHandler } from "../types.js";
import { parsePatch } from "./patch-parser.js";
import { applyPatch } from "./patch-applier.js";

interface FileChange {
  absolutePath: string;
  newContent: string;
  hunkCount: number;
}

export const applyPatchTool: ToolHandler = {
  name: "apply_patch",
  description:
    "Apply a unified diff patch to one or more files atomically. " +
    "If any hunk fails to apply, no files are modified.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "A unified diff string (the content between ``` markers). Must include --- and +++ headers and @@ hunk headers.",
      },
      workingDirectory: {
        type: "string",
        description:
          "Absolute path to resolve relative file paths against. Defaults to '/'.",
      },
    },
    required: ["patch"],
  },
  requiredCapabilities: ["fs:read", "fs:write"],

  async execute(args: Record<string, unknown>): Promise<string> {
    const patch = args["patch"];
    if (typeof patch !== "string") {
      throw new Error("Required argument 'patch' must be a string");
    }

    const workingDirectory = args["workingDirectory"];
    if (
      workingDirectory !== undefined &&
      typeof workingDirectory !== "string"
    ) {
      throw new Error("'workingDirectory' must be a string");
    }

    const baseDir =
      typeof workingDirectory === "string" ? workingDirectory : "/";

    // Phase 1: Parse the patch
    const patchFiles = parsePatch(patch);

    // Phase 2: Read all files and compute all changes (atomic: no writes yet)
    const changes: FileChange[] = [];

    for (const patchFile of patchFiles) {
      const relativePath = patchFile.path;
      const absolutePath = isAbsolute(relativePath)
        ? relativePath
        : join(baseDir, relativePath);

      const firstHunk = patchFile.hunks[0];
      const isNewFile =
        firstHunk !== undefined &&
        firstHunk.oldStart === 0 &&
        firstHunk.oldCount === 0;

      let originalContent: string;
      if (isNewFile && !existsSync(absolutePath)) {
        originalContent = "";
      } else {
        originalContent = readFileSync(absolutePath, "utf-8");
      }

      const newContent = applyPatch(patchFile, originalContent);

      changes.push({
        absolutePath,
        newContent,
        hunkCount: patchFile.hunks.length,
      });
    }

    // Phase 3: Write all changes (only reached if all patches computed successfully)
    for (const change of changes) {
      const dir = dirname(change.absolutePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(change.absolutePath, change.newContent, "utf-8");
    }

    // Phase 4: Build summary
    const fileCount = changes.length;
    const totalHunks = changes.reduce((sum, c) => sum + c.hunkCount, 0);
    const details = changes
      .map((c) => {
        const name = c.absolutePath;
        return `${name} (${c.hunkCount} ${c.hunkCount === 1 ? "hunk" : "hunks"})`;
      })
      .join(", ");

    return (
      `Applied ${totalHunks} ${totalHunks === 1 ? "hunk" : "hunks"} to ` +
      `${fileCount} ${fileCount === 1 ? "file" : "files"}: ${details}`
    );
  },
};
