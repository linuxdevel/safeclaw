import { execFile } from "node:child_process";
import type { ToolHandler } from "../types.js";

const DEFAULT_TIMEOUT = 120_000;

export const bashTool: ToolHandler = {
  name: "bash",
  description: "Execute a shell command via /bin/bash",
  requiredCapabilities: ["process:spawn"],

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args["command"];
    if (typeof command !== "string") {
      throw new Error("Required argument 'command' must be a string");
    }

    const timeout =
      args["timeout"] !== undefined ? Number(args["timeout"]) : DEFAULT_TIMEOUT;
    if (Number.isNaN(timeout)) {
      throw new Error("'timeout' must be a number");
    }

    const workdir =
      args["workdir"] !== undefined ? String(args["workdir"]) : undefined;

    return new Promise<string>((resolve, _reject) => {
      execFile(
        "/bin/bash",
        ["-c", command],
        {
          timeout,
          cwd: workdir,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) {
            // Non-zero exit: still return output rather than rejecting,
            // since the LLM needs to see error messages
            const errWithOutput = err as Error & {
              stdout?: string;
              stderr?: string;
              code?: number;
            };
            const parts: string[] = [];
            if (errWithOutput.stdout) parts.push(errWithOutput.stdout);
            if (errWithOutput.stderr) parts.push(errWithOutput.stderr);
            if (parts.length === 0) parts.push(err.message);
            resolve(parts.join("\n"));
            return;
          }
          const parts: string[] = [];
          if (stdout) parts.push(stdout);
          if (stderr) parts.push(stderr);
          resolve(parts.join("\n"));
        },
      );
    });
  },
};
