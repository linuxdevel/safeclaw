import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { applyPatchTool } from "./apply-patch.js";

describe("applyPatchTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name and metadata", () => {
    expect(applyPatchTool.name).toBe("apply_patch");
    expect(applyPatchTool.description).toBeTruthy();
    expect(applyPatchTool.requiredCapabilities).toEqual([
      "fs:read",
      "fs:write",
    ]);
  });

  it("applies a single-file patch", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("line1\nold\nline3\n");

    const patch = [
      "--- a/tmp/test.ts",
      "+++ b/tmp/test.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old",
      "+new",
      " line3",
    ].join("\n");

    const result = await applyPatchTool.execute({
      patch,
      workingDirectory: "/",
    });

    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test.ts",
      "line1\nnew\nline3\n",
      "utf-8",
    );
    expect(result).toContain("1 file");
    expect(result).toContain("1 hunk");
  });

  it("applies a multi-file patch atomically", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync)
      .mockReturnValueOnce("old1\n")
      .mockReturnValueOnce("old2\n");

    const patch = [
      "--- a/tmp/a.ts",
      "+++ b/tmp/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old1",
      "+new1",
      "--- a/tmp/b.ts",
      "+++ b/tmp/b.ts",
      "@@ -1,1 +1,1 @@",
      "-old2",
      "+new2",
    ].join("\n");

    const result = await applyPatchTool.execute({
      patch,
      workingDirectory: "/",
    });

    expect(writeFileSync).toHaveBeenCalledTimes(2);
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/a.ts",
      "new1\n",
      "utf-8",
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/b.ts",
      "new2\n",
      "utf-8",
    );
    expect(result).toContain("2 files");
  });

  it("rolls back on failure (second file fails)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync)
      .mockReturnValueOnce("old1\n") // first file read for patching
      .mockReturnValueOnce("wrong content\n"); // second file -- will fail

    const patch = [
      "--- a/tmp/a.ts",
      "+++ b/tmp/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old1",
      "+new1",
      "--- a/tmp/b.ts",
      "+++ b/tmp/b.ts",
      "@@ -1,1 +1,1 @@",
      "-expected",
      "+replaced",
    ].join("\n");

    await expect(
      applyPatchTool.execute({ patch, workingDirectory: "/" }),
    ).rejects.toThrow(/mismatch/i);

    // No files should have been written because the error happens
    // during the compute phase, before any writes
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("handles new file creation", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const patch = [
      "--- /dev/null",
      "+++ b/tmp/new-file.ts",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
    ].join("\n");

    const result = await applyPatchTool.execute({
      patch,
      workingDirectory: "/",
    });

    expect(mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/new-file.ts",
      "hello\nworld\n",
      "utf-8",
    );
    expect(result).toContain("1 file");
  });

  it("rejects missing patch argument", async () => {
    await expect(applyPatchTool.execute({})).rejects.toThrow(/patch/i);
  });

  it("rejects non-string patch argument", async () => {
    await expect(
      applyPatchTool.execute({ patch: 42 }),
    ).rejects.toThrow(/patch.*string/i);
  });

  it("uses workingDirectory to resolve relative paths", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("old\n");

    const patch = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    await applyPatchTool.execute({
      patch,
      workingDirectory: "/home/user/project",
    });

    expect(readFileSync).toHaveBeenCalledWith(
      "/home/user/project/src/foo.ts",
      "utf-8",
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      "/home/user/project/src/foo.ts",
      "new\n",
      "utf-8",
    );
  });
});
