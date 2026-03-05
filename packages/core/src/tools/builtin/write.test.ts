import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { writeFileSync, mkdirSync } from "node:fs";
import { writeTool } from "./write.js";

describe("writeTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name and metadata", () => {
    expect(writeTool.name).toBe("write");
    expect(writeTool.description).toBeTruthy();
    expect(writeTool.requiredCapabilities).toEqual(["fs:write"]);
  });

  it("exposes a valid JSON Schema for parameters", () => {
    expect(writeTool.parameters).toEqual({
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
    });
  });

  it("writes content to a file and creates parent dirs", async () => {
    const result = await writeTool.execute({
      path: "/tmp/sub/test.txt",
      content: "hello world",
    });

    expect(mkdirSync).toHaveBeenCalledWith("/tmp/sub", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith("/tmp/sub/test.txt", "hello world", "utf-8");
    expect(result).toContain("/tmp/sub/test.txt");
  });

  it("rejects non-absolute paths", async () => {
    await expect(
      writeTool.execute({ path: "relative.txt", content: "hi" }),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects missing path argument", async () => {
    await expect(writeTool.execute({ content: "hi" })).rejects.toThrow(/path/i);
  });

  it("rejects missing content argument", async () => {
    await expect(writeTool.execute({ path: "/tmp/test.txt" })).rejects.toThrow(
      /content/i,
    );
  });

  it("rejects non-string path", async () => {
    await expect(
      writeTool.execute({ path: 123, content: "hi" }),
    ).rejects.toThrow(/path/i);
  });

  it("rejects non-string content", async () => {
    await expect(
      writeTool.execute({ path: "/tmp/test.txt", content: 123 }),
    ).rejects.toThrow(/content/i);
  });

  it("surfaces filesystem errors", async () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await expect(
      writeTool.execute({ path: "/root/secret.txt", content: "x" }),
    ).rejects.toThrow(/EACCES/);
  });
});
