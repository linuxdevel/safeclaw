import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { readFileSync, writeFileSync } from "node:fs";
import { editTool } from "./edit.js";

describe("editTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name and metadata", () => {
    expect(editTool.name).toBe("edit");
    expect(editTool.description).toBeTruthy();
    expect(editTool.requiredCapabilities).toEqual(["fs:read", "fs:write"]);
  });

  it("replaces a unique string in a file", async () => {
    vi.mocked(readFileSync).mockReturnValue("hello world");

    const result = await editTool.execute({
      path: "/tmp/test.txt",
      oldString: "hello",
      newString: "goodbye",
    });

    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test.txt",
      "goodbye world",
      "utf-8",
    );
    expect(result).toContain("Applied");
  });

  it("rejects when oldString is not found", async () => {
    vi.mocked(readFileSync).mockReturnValue("hello world");

    await expect(
      editTool.execute({
        path: "/tmp/test.txt",
        oldString: "missing",
        newString: "replacement",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects when oldString has multiple matches and replaceAll is not set", async () => {
    vi.mocked(readFileSync).mockReturnValue("foo bar foo baz foo");

    await expect(
      editTool.execute({
        path: "/tmp/test.txt",
        oldString: "foo",
        newString: "qux",
      }),
    ).rejects.toThrow(/multiple/i);
  });

  it("replaces all occurrences when replaceAll is true", async () => {
    vi.mocked(readFileSync).mockReturnValue("foo bar foo baz foo");

    const result = await editTool.execute({
      path: "/tmp/test.txt",
      oldString: "foo",
      newString: "qux",
      replaceAll: true,
    });

    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test.txt",
      "qux bar qux baz qux",
      "utf-8",
    );
    expect(result).toContain("3");
  });

  it("rejects non-absolute paths", async () => {
    await expect(
      editTool.execute({
        path: "relative.txt",
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects missing required arguments", async () => {
    await expect(editTool.execute({ path: "/tmp/test.txt" })).rejects.toThrow(
      /oldString/i,
    );
    await expect(
      editTool.execute({ path: "/tmp/test.txt", oldString: "a" }),
    ).rejects.toThrow(/newString/i);
  });

  it("rejects when oldString equals newString", async () => {
    await expect(
      editTool.execute({
        path: "/tmp/test.txt",
        oldString: "same",
        newString: "same",
      }),
    ).rejects.toThrow(/different/i);
  });

  it("surfaces filesystem errors", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    await expect(
      editTool.execute({
        path: "/tmp/missing.txt",
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
