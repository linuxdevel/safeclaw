import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { readTool } from "./read.js";

describe("readTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name and metadata", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.description).toBeTruthy();
    expect(readTool.requiredCapabilities).toEqual(["fs:read"]);
  });

  it("exposes a valid JSON Schema for parameters", () => {
    expect(readTool.parameters).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to read",
        },
        offset: {
          type: "integer",
          description: "Line number to start from (1-indexed)",
          minimum: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to read",
          minimum: 1,
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("reads a file and returns line-numbered content", async () => {
    vi.mocked(readFileSync).mockReturnValue("hello\nworld\n");

    const result = await readTool.execute({ path: "/tmp/test.txt" });

    expect(readFileSync).toHaveBeenCalledWith("/tmp/test.txt", "utf-8");
    expect(result).toContain("1: hello");
    expect(result).toContain("2: world");
  });

  it("rejects non-absolute paths", async () => {
    await expect(readTool.execute({ path: "relative/path.txt" })).rejects.toThrow(
      /absolute/i,
    );
  });

  it("rejects missing path argument", async () => {
    await expect(readTool.execute({})).rejects.toThrow(/path/i);
  });

  it("rejects non-string path", async () => {
    await expect(readTool.execute({ path: 42 })).rejects.toThrow(/path/i);
  });

  it("applies offset parameter (1-indexed)", async () => {
    vi.mocked(readFileSync).mockReturnValue("line1\nline2\nline3\nline4\n");

    const result = await readTool.execute({ path: "/tmp/test.txt", offset: 2 });

    expect(result).not.toContain("1: line1");
    expect(result).toContain("2: line2");
    expect(result).toContain("3: line3");
    expect(result).toContain("4: line4");
  });

  it("applies limit parameter", async () => {
    vi.mocked(readFileSync).mockReturnValue("line1\nline2\nline3\nline4\n");

    const result = await readTool.execute({ path: "/tmp/test.txt", limit: 2 });

    expect(result).toContain("1: line1");
    expect(result).toContain("2: line2");
    expect(result).not.toContain("3: line3");
  });

  it("applies offset and limit together", async () => {
    vi.mocked(readFileSync).mockReturnValue("a\nb\nc\nd\ne\n");

    const result = await readTool.execute({
      path: "/tmp/test.txt",
      offset: 2,
      limit: 2,
    });

    expect(result).not.toContain("1: a");
    expect(result).toContain("2: b");
    expect(result).toContain("3: c");
    expect(result).not.toContain("4: d");
  });

  it("surfaces filesystem errors", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    await expect(readTool.execute({ path: "/tmp/missing.txt" })).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("handles empty file", async () => {
    vi.mocked(readFileSync).mockReturnValue("");

    const result = await readTool.execute({ path: "/tmp/empty.txt" });

    expect(result).toBe("");
  });

  it("rejects NaN offset", async () => {
    await expect(
      readTool.execute({ path: "/tmp/test.txt", offset: "abc" }),
    ).rejects.toThrow(/offset.*number/i);
  });

  it("rejects offset less than 1", async () => {
    await expect(
      readTool.execute({ path: "/tmp/test.txt", offset: 0 }),
    ).rejects.toThrow(/offset.*>= 1/i);
  });

  it("rejects NaN limit", async () => {
    await expect(
      readTool.execute({ path: "/tmp/test.txt", limit: "abc" }),
    ).rejects.toThrow(/limit.*number/i);
  });

  it("rejects limit less than 1", async () => {
    await expect(
      readTool.execute({ path: "/tmp/test.txt", limit: 0 }),
    ).rejects.toThrow(/limit.*>= 1/i);
  });

  it("handles file without trailing newline", async () => {
    vi.mocked(readFileSync).mockReturnValue("line1\nline2");

    const result = await readTool.execute({ path: "/tmp/test.txt" });

    expect(result).toContain("1: line1");
    expect(result).toContain("2: line2");
  });
});
