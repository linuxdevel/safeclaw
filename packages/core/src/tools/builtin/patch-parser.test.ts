import { describe, it, expect } from "vitest";
import { parsePatch } from "./patch-parser.js";

describe("parsePatch", () => {
  it("parses a single-file patch with one hunk", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,3 +10,4 @@",
      " existing line",
      "-old line",
      "+new line",
      "+added line",
      " existing line",
    ].join("\n");

    const result = parsePatch(diff);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/foo.ts");
    expect(result[0].hunks).toHaveLength(1);

    const hunk = result[0].hunks[0];
    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldCount).toBe(3);
    expect(hunk.newStart).toBe(10);
    expect(hunk.newCount).toBe(4);
    expect(hunk.lines).toEqual([
      { type: "context", content: "existing line" },
      { type: "remove", content: "old line" },
      { type: "add", content: "new line" },
      { type: "add", content: "added line" },
      { type: "context", content: "existing line" },
    ]);
  });

  it("parses a multi-file patch", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " keep",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -5,2 +5,2 @@",
      "-removed",
      "+replaced",
      " context",
    ].join("\n");

    const result = parsePatch(diff);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("src/foo.ts");
    expect(result[1].path).toBe("src/bar.ts");
    expect(result[0].hunks).toHaveLength(1);
    expect(result[1].hunks).toHaveLength(1);
  });

  it("parses multiple hunks in a single file", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old2",
      "+new2",
      " line3",
      "@@ -20,3 +20,3 @@",
      " line20",
      "-old21",
      "+new21",
      " line22",
    ].join("\n");

    const result = parsePatch(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(2);
    expect(result[0].hunks[0].oldStart).toBe(1);
    expect(result[0].hunks[1].oldStart).toBe(20);
  });

  it("parses new file creation (--- /dev/null)", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/src/new-file.ts",
      "@@ -0,0 +1,3 @@",
      "+line1",
      "+line2",
      "+line3",
    ].join("\n");

    const result = parsePatch(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/new-file.ts");
    expect(result[0].hunks[0].oldStart).toBe(0);
    expect(result[0].hunks[0].oldCount).toBe(0);
    expect(result[0].hunks[0].newStart).toBe(1);
    expect(result[0].hunks[0].newCount).toBe(3);
  });

  it("parses file deletion (+++ /dev/null)", () => {
    const diff = [
      "--- a/src/old-file.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-line1",
      "-line2",
      "-line3",
    ].join("\n");

    const result = parsePatch(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/old-file.ts");
  });

  it("handles hunk headers without count (implies count=1)", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -5 +5 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = parsePatch(diff);
    expect(result[0].hunks[0].oldCount).toBe(1);
    expect(result[0].hunks[0].newCount).toBe(1);
  });

  it("throws on empty patch", () => {
    expect(() => parsePatch("")).toThrow(/no file headers/i);
  });

  it("throws on hunk header without file header", () => {
    const diff = "@@ -1,2 +1,2 @@\n-old\n+new";
    expect(() => parsePatch(diff)).toThrow(/without file header/i);
  });

  it("throws on --- without matching +++ line", () => {
    expect(() => parsePatch("--- a/foo.ts\n")).toThrow(/Expected '\+\+\+ '/);
  });

  it("handles trailing newline in patch", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "", // trailing newline
    ].join("\n");

    const result = parsePatch(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks[0].lines).toHaveLength(2);
  });
});
