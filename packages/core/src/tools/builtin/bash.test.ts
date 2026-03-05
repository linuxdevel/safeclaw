import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { bashTool } from "./bash.js";

describe("bashTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name and metadata", () => {
    expect(bashTool.name).toBe("bash");
    expect(bashTool.description).toBeTruthy();
    expect(bashTool.requiredCapabilities).toEqual(["process:spawn"]);
  });

  it("exposes a valid JSON Schema for parameters", () => {
    expect(bashTool.parameters).toEqual({
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
    });
  });

  it("executes a command via /bin/bash and returns stdout", async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          "hello\n",
          "",
        );
        return undefined as never;
      },
    );

    const result = await bashTool.execute({ command: "echo hello" });

    expect(execFile).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", "echo hello"],
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    );
    expect(result).toContain("hello");
  });

  it("includes stderr in output", async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          "out\n",
          "err\n",
        );
        return undefined as never;
      },
    );

    const result = await bashTool.execute({ command: "some-cmd" });

    expect(result).toContain("out");
    expect(result).toContain("err");
  });

  it("uses custom timeout when provided", async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, "", "");
        return undefined as never;
      },
    );

    await bashTool.execute({ command: "ls", timeout: 5000 });

    expect(execFile).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", "ls"],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it("uses custom workdir when provided", async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, "", "");
        return undefined as never;
      },
    );

    await bashTool.execute({ command: "ls", workdir: "/tmp" });

    expect(execFile).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", "ls"],
      expect.objectContaining({ cwd: "/tmp" }),
      expect.any(Function),
    );
  });

  it("rejects missing command argument", async () => {
    await expect(bashTool.execute({})).rejects.toThrow(/command/i);
  });

  it("rejects non-string command", async () => {
    await expect(bashTool.execute({ command: 42 })).rejects.toThrow(/command/i);
  });

  it("surfaces execution errors with exit code", async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        const err = new Error("Command failed") as Error & {
          code: number;
          stdout: string;
          stderr: string;
        };
        err.code = 1;
        err.stdout = "partial output";
        err.stderr = "error output";
        (cb as (err: Error) => void)(err);
        return undefined as never;
      },
    );

    const result = await bashTool.execute({ command: "exit 1" });

    expect(result).toContain("error output");
  });

  it("rejects NaN timeout", async () => {
    await expect(
      bashTool.execute({ command: "ls", timeout: "abc" }),
    ).rejects.toThrow(/timeout.*number/i);
  });

  it("falls back to error message when no stdout/stderr on error", async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        const err = new Error("spawn failed");
        (cb as (err: Error) => void)(err);
        return undefined as never;
      },
    );

    const result = await bashTool.execute({ command: "bad-command" });

    expect(result).toContain("spawn failed");
  });

  describe("command validation", () => {
    it("warns when command binary is outside allowed paths", async () => {
      // Mock which to return a path outside allowed dirs
      vi.mocked(execFile).mockImplementation(
        (cmd: unknown, args: unknown, opts: unknown, cb: unknown) => {
          const cmdStr = cmd as string;
          const argsArr = args as string[];
          if (cmdStr === "which" || (cmdStr === "/bin/bash" && argsArr[1] === "which suspicious-binary")) {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "/opt/sketchy/suspicious-binary\n",
              "",
            );
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "done\n",
              "",
            );
          }
          return undefined as never;
        },
      );

      const result = await bashTool.execute({
        command: "suspicious-binary --flag",
        allowedPaths: ["/bin", "/usr/bin", "/usr/local/bin"],
      });

      expect(result).toContain("Warning");
      expect(result).toContain("suspicious-binary");
      expect(result).toContain("not on the allowed");
    });

    it("does not warn when command binary is in allowed paths", async () => {
      vi.mocked(execFile).mockImplementation(
        (cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
          const cmdStr = cmd as string;
          const argsArr = args as string[];
          if (cmdStr === "/bin/bash" && argsArr[1] === "which ls") {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "/usr/bin/ls\n",
              "",
            );
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "output\n",
              "",
            );
          }
          return undefined as never;
        },
      );

      const result = await bashTool.execute({
        command: "ls -la",
        allowedPaths: ["/bin", "/usr/bin", "/usr/local/bin"],
      });

      expect(result).not.toContain("Warning");
      expect(result).toContain("output");
    });

    it("skips validation when allowedPaths is not provided", async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          (cb as (err: null, stdout: string, stderr: string) => void)(
            null,
            "output\n",
            "",
          );
          return undefined as never;
        },
      );

      const result = await bashTool.execute({ command: "some-cmd" });

      expect(result).not.toContain("Warning");
      // which should not have been called — only one execFile call for the actual command
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    it("skips validation for shell builtins (cd, echo, etc.)", async () => {
      vi.mocked(execFile).mockImplementation(
        (cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
          const cmdStr = cmd as string;
          const argsArr = args as string[];
          if (cmdStr === "/bin/bash" && argsArr[1]?.startsWith("which ")) {
            // which would fail for builtins
            const err = new Error("not found") as Error & {
              code: number;
              stdout: string;
              stderr: string;
            };
            err.code = 1;
            err.stdout = "";
            err.stderr = "";
            (cb as (err: Error) => void)(err);
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "output\n",
              "",
            );
          }
          return undefined as never;
        },
      );

      const result = await bashTool.execute({
        command: "echo hello",
        allowedPaths: ["/bin", "/usr/bin"],
      });

      // Should not warn for builtins — just proceed
      expect(result).not.toContain("Warning");
    });

    it("warns for compiler outside allowed paths", async () => {
      vi.mocked(execFile).mockImplementation(
        (cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
          const cmdStr = cmd as string;
          const argsArr = args as string[];
          if (cmdStr === "/bin/bash" && argsArr[1] === "which rustc") {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "/home/user/.cargo/bin/rustc\n",
              "",
            );
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "compiled\n",
              "",
            );
          }
          return undefined as never;
        },
      );

      const result = await bashTool.execute({
        command: "rustc main.rs",
        allowedPaths: ["/bin", "/usr/bin", "/usr/local/bin"],
      });

      expect(result).toContain("Warning");
      expect(result).toContain("rustc");
    });

    it("does not warn for compiler inside allowed paths", async () => {
      vi.mocked(execFile).mockImplementation(
        (cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
          const cmdStr = cmd as string;
          const argsArr = args as string[];
          if (cmdStr === "/bin/bash" && argsArr[1] === "which gcc") {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "/usr/bin/gcc\n",
              "",
            );
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              "compiled\n",
              "",
            );
          }
          return undefined as never;
        },
      );

      const result = await bashTool.execute({
        command: "gcc -o main main.c",
        allowedPaths: ["/bin", "/usr/bin", "/usr/local/bin"],
      });

      expect(result).not.toContain("Warning");
    });
  });
});
