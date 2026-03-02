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
});
