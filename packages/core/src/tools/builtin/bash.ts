import { execFile } from "node:child_process";
import type { ToolHandler } from "../types.js";

const DEFAULT_TIMEOUT = 120_000;

/** Shell builtins that `which` cannot resolve — skip validation for these */
const SHELL_BUILTINS = new Set([
  "alias", "bg", "bind", "break", "builtin", "caller", "case", "cd",
  "command", "compgen", "complete", "compopt", "continue", "coproc",
  "declare", "dirs", "disown", "do", "done", "echo", "elif", "else",
  "enable", "esac", "eval", "exec", "exit", "export", "false", "fc",
  "fg", "fi", "for", "function", "getopts", "hash", "help", "history",
  "if", "in", "jobs", "let", "local", "logout", "mapfile", "popd",
  "printf", "pushd", "pwd", "read", "readarray", "readonly", "return",
  "select", "set", "shift", "shopt", "source", "suspend", "test",
  "then", "time", "times", "trap", "true", "type", "typeset", "ulimit",
  "umask", "unalias", "unset", "until", "wait", "while",
]);

/**
 * Extract the first command binary name from a shell command string.
 * Handles: "gcc -o main main.c", "FOO=1 gcc ...", "cd /tmp && ls", etc.
 */
function extractBinaryName(command: string): string | undefined {
  // Strip leading env assignments (VAR=value)
  const tokens = command.trim().split(/\s+/);
  for (const token of tokens) {
    if (token.includes("=") && !token.startsWith("-")) continue;
    // Return the first non-assignment token (the binary name)
    return token;
  }
  return undefined;
}

/**
 * Resolve a command binary path using `which` and check if it's in the allowed paths.
 * Returns a warning string if the binary is outside allowed paths, or undefined if OK.
 */
function validateCommand(
  binary: string,
  allowedPaths: string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (SHELL_BUILTINS.has(binary)) {
      resolve(undefined);
      return;
    }

    execFile(
      "/bin/bash",
      ["-c", `which ${binary}`],
      { timeout: 5_000 },
      (err: Error | null, stdout: string) => {
        if (err) {
          // `which` failed — binary not found or is a builtin. Don't warn.
          resolve(undefined);
          return;
        }

        const resolvedPath = stdout.trim();
        if (!resolvedPath) {
          resolve(undefined);
          return;
        }

        // Check if resolved path is under any allowed path
        const isAllowed = allowedPaths.some(
          (allowed) =>
            resolvedPath === allowed ||
            resolvedPath.startsWith(allowed + "/"),
        );

        if (!isAllowed) {
          resolve(
            `Warning: Command '${binary}' resolves to '${resolvedPath}' which is not on the allowed paths list.\n` +
            `Allowed paths: ${allowedPaths.join(", ")}\n` +
            `The sandbox's Landlock rules will still enforce filesystem restrictions.\n`,
          );
        } else {
          resolve(undefined);
        }
      },
    );
  });
}

export interface BashToolOptions {
  /** Allowed filesystem paths for command validation (advisory check) */
  allowedPaths?: string[];
}

/**
 * Creates a bash tool handler with optional command validation.
 * When `allowedPaths` is provided, the tool will warn (not block) if the
 * command binary resolves to a path outside the allowed list.
 */
export function createBashTool(options?: BashToolOptions): ToolHandler {
  const configuredAllowedPaths = options?.allowedPaths;

  return {
    name: "bash",
    description: "Execute a shell command via /bin/bash",
    requiredCapabilities: ["process:spawn"],

    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute via /bin/bash",
        },
        timeout: {
          type: "integer",
          description: "Timeout in milliseconds",
          default: 120000,
          minimum: 1,
        },
        workdir: {
          type: "string",
          description: "Working directory for command execution",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },

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

      // Advisory command validation — check if binary is in allowed paths
      // Use runtime args override if provided, otherwise use configured paths
      const allowedPaths =
        (args["allowedPaths"] as string[] | undefined) ?? configuredAllowedPaths;
      let warning: string | undefined;
      if (allowedPaths && allowedPaths.length > 0) {
        const binary = extractBinaryName(command);
        if (binary) {
          warning = await validateCommand(binary, allowedPaths);
        }
      }

      const output = await new Promise<string>((resolve) => {
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

      if (warning) {
        return warning + output;
      }
      return output;
    },
  };
}

/** Default bash tool (no command validation) for backwards compatibility */
export const bashTool: ToolHandler = createBashTool();
