# Multi-file Patch Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `apply_patch` tool that parses unified diff format and applies multi-file patches atomically.

**Architecture:** Create a patch parser that splits a unified diff string into per-file `PatchFile` objects, each containing typed hunks. A patch applier applies hunks sequentially to file content with fuzzy line-offset matching. The `apply_patch` tool orchestrates atomicity: it reads all target files first, computes all patched content, then writes all files -- rolling back on any failure. New files: `patch-parser.ts`, `patch-applier.ts`, `apply-patch.ts` in `packages/core/src/tools/builtin/`.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Create patch parser types and basic parsing

**Files:**
- Create: `packages/core/src/tools/builtin/patch-parser.ts`
- Create: `packages/core/src/tools/builtin/patch-parser.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/tools/builtin/patch-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parsePatch } from "./patch-parser.js";
import type { PatchFile, Hunk, HunkLine } from "./patch-parser.js";

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
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/tools/builtin/patch-parser.test.ts`
Expected: FAIL -- cannot find module `./patch-parser.js`

**Step 3: Write minimal implementation**

Create `packages/core/src/tools/builtin/patch-parser.ts`:

```typescript
export interface HunkLine {
  type: "context" | "add" | "remove";
  content: string;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface PatchFile {
  path: string;
  hunks: Hunk[];
}

/**
 * Parse a unified diff string into structured PatchFile objects.
 * Handles standard `--- a/path` / `+++ b/path` headers,
 * `@@ -old,count +new,count @@` hunk headers,
 * and context/add/remove lines.
 */
export function parsePatch(diff: string): PatchFile[] {
  const lines = diff.split("\n");
  const files: PatchFile[] = [];
  let currentFile: PatchFile | undefined;
  let currentHunk: Hunk | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // File header: --- a/path or --- /dev/null
    if (line.startsWith("--- ")) {
      // Next line must be +++ b/path
      const plusLine = lines[i + 1];
      if (!plusLine || !plusLine.startsWith("+++ ")) {
        throw new Error(`Expected '+++ ' line after '--- ' at line ${i + 1}`);
      }

      const oldPath = parseFilePath(line.slice(4));
      const newPath = parseFilePath(plusLine.slice(4));

      // Use the new path unless it's /dev/null (deletion)
      const path = newPath === "/dev/null" ? oldPath : newPath;

      currentFile = { path, hunks: [] };
      files.push(currentFile);
      currentHunk = undefined;
      i += 2;
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    );
    if (hunkMatch) {
      if (!currentFile) {
        throw new Error(`Hunk header without file header at line ${i + 1}`);
      }
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      i++;
      continue;
    }

    // Hunk content lines
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: "context", content: line.slice(1) });
      } else if (line === "") {
        // Empty line at end of input -- skip
      } else {
        // Unrecognized line inside a hunk -- treat as end of hunk
        currentHunk = undefined;
        continue; // re-process this line
      }
    }

    i++;
  }

  if (files.length === 0) {
    throw new Error("No file headers found in patch");
  }

  return files;
}

/**
 * Parse a file path from a diff header, stripping the a/ or b/ prefix.
 */
function parseFilePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "/dev/null") return "/dev/null";
  // Strip a/ or b/ prefix
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/tools/builtin/patch-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/patch-parser.ts packages/core/src/tools/builtin/patch-parser.test.ts
git commit -m "feat(tools): add patch parser with single-file single-hunk support"
```

---

### Task 2: Extend patch parser tests for multi-file, multi-hunk, and edge cases

**Files:**
- Modify: `packages/core/src/tools/builtin/patch-parser.test.ts`

**Step 1: Add more tests**

Append the following tests inside the existing `describe("parsePatch", ...)` block:

```typescript
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
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/tools/builtin/patch-parser.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/core/src/tools/builtin/patch-parser.test.ts
git commit -m "test(tools): add comprehensive patch parser tests"
```

---

### Task 3: Create patch applier with basic hunk application

**Files:**
- Create: `packages/core/src/tools/builtin/patch-applier.ts`
- Create: `packages/core/src/tools/builtin/patch-applier.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/tools/builtin/patch-applier.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyPatch } from "./patch-applier.js";
import type { PatchFile } from "./patch-parser.js";

describe("applyPatch", () => {
  it("applies a simple replacement hunk", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 2,
          oldCount: 3,
          newStart: 2,
          newCount: 3,
          lines: [
            { type: "context", content: "line2" },
            { type: "remove", content: "old3" },
            { type: "add", content: "new3" },
            { type: "context", content: "line4" },
          ],
        },
      ],
    };

    const original = "line1\nline2\nold3\nline4\nline5\n";
    const result = applyPatch(file, original);
    expect(result).toBe("line1\nline2\nnew3\nline4\nline5\n");
  });

  it("applies an addition hunk", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 4,
          lines: [
            { type: "context", content: "line1" },
            { type: "add", content: "inserted1" },
            { type: "add", content: "inserted2" },
            { type: "context", content: "line2" },
          ],
        },
      ],
    };

    const original = "line1\nline2\nline3\n";
    const result = applyPatch(file, original);
    expect(result).toBe("line1\ninserted1\ninserted2\nline2\nline3\n");
  });

  it("applies a deletion hunk", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: "context", content: "keep" },
            { type: "remove", content: "delete1" },
            { type: "remove", content: "delete2" },
          ],
        },
      ],
    };

    const original = "keep\ndelete1\ndelete2\nafter\n";
    const result = applyPatch(file, original);
    expect(result).toBe("keep\nafter\n");
  });

  it("applies multiple hunks in sequence", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: "remove", content: "first" },
            { type: "add", content: "FIRST" },
          ],
        },
        {
          oldStart: 5,
          oldCount: 1,
          newStart: 5,
          newCount: 1,
          lines: [
            { type: "remove", content: "fifth" },
            { type: "add", content: "FIFTH" },
          ],
        },
      ],
    };

    const original = "first\nsecond\nthird\nfourth\nfifth\nsixth\n";
    const result = applyPatch(file, original);
    expect(result).toBe("FIRST\nsecond\nthird\nfourth\nFIFTH\nsixth\n");
  });

  it("throws when context line does not match", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: "context", content: "expected" },
            { type: "remove", content: "old" },
            { type: "add", content: "new" },
          ],
        },
      ],
    };

    const original = "different\nold\n";
    expect(() => applyPatch(file, original)).toThrow(/context mismatch/i);
  });

  it("throws when remove line does not match", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: "remove", content: "expected" },
            { type: "add", content: "new" },
          ],
        },
      ],
    };

    const original = "different\n";
    expect(() => applyPatch(file, original)).toThrow(/remove line mismatch/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/tools/builtin/patch-applier.test.ts`
Expected: FAIL -- cannot find module `./patch-applier.js`

**Step 3: Write minimal implementation**

Create `packages/core/src/tools/builtin/patch-applier.ts`:

```typescript
import type { PatchFile, Hunk } from "./patch-parser.js";

/**
 * Apply all hunks from a PatchFile to file content, returning the new content.
 *
 * Hunks are applied in order. Context and remove lines are verified against
 * the original content. If any line does not match, an error is thrown.
 *
 * Supports fuzzy matching: if a hunk's target line offset doesn't match,
 * searches up to 3 lines above and below for the correct position.
 */
export function applyPatch(patch: PatchFile, fileContent: string): string {
  const hadTrailingNewline = fileContent.endsWith("\n");
  const lines = fileContent.length === 0
    ? []
    : hadTrailingNewline
      ? fileContent.slice(0, -1).split("\n")
      : fileContent.split("\n");

  // Track cumulative offset from previous hunk applications
  let cumulativeOffset = 0;

  for (const hunk of patch.hunks) {
    const result = applyHunk(lines, hunk, cumulativeOffset);
    cumulativeOffset = result.newOffset;
  }

  const joined = lines.join("\n");
  return hadTrailingNewline || fileContent.length === 0
    ? joined + "\n"
    : joined;
}

const FUZZ_LIMIT = 3;

function applyHunk(
  lines: string[],
  hunk: Hunk,
  cumulativeOffset: number,
): { newOffset: number } {
  // oldStart is 1-indexed; convert to 0-indexed and apply cumulative offset
  const nominalStart = hunk.oldStart - 1 + cumulativeOffset;

  // Try exact position first, then fuzz up/down
  const startPos = findHunkPosition(lines, hunk, nominalStart);

  // Apply the hunk at startPos
  let readPos = startPos;
  const newLines: string[] = [];
  let removedCount = 0;

  for (const hunkLine of hunk.lines) {
    if (hunkLine.type === "context") {
      if (readPos >= lines.length || lines[readPos] !== hunkLine.content) {
        throw new Error(
          `Context mismatch at line ${readPos + 1}: expected "${hunkLine.content}", got "${lines[readPos] ?? "EOF"}"`,
        );
      }
      newLines.push(lines[readPos]);
      readPos++;
    } else if (hunkLine.type === "remove") {
      if (readPos >= lines.length || lines[readPos] !== hunkLine.content) {
        throw new Error(
          `Remove line mismatch at line ${readPos + 1}: expected "${hunkLine.content}", got "${lines[readPos] ?? "EOF"}"`,
        );
      }
      readPos++;
      removedCount++;
    } else {
      // add
      newLines.push(hunkLine.content);
    }
  }

  // Splice: remove consumed lines, insert new lines
  const consumedCount = readPos - startPos;
  lines.splice(startPos, consumedCount, ...newLines);

  // Update cumulative offset: difference in line count
  const delta = newLines.length - consumedCount;
  return { newOffset: cumulativeOffset + delta };
}

/**
 * Find the position in `lines` where the hunk matches.
 * Tries the nominal position first, then fuzzes up to FUZZ_LIMIT lines
 * above and below.
 */
function findHunkPosition(
  lines: string[],
  hunk: Hunk,
  nominalStart: number,
): number {
  if (hunkMatchesAt(lines, hunk, nominalStart)) {
    return nominalStart;
  }

  for (let offset = 1; offset <= FUZZ_LIMIT; offset++) {
    if (
      nominalStart - offset >= 0 &&
      hunkMatchesAt(lines, hunk, nominalStart - offset)
    ) {
      return nominalStart - offset;
    }
    if (hunkMatchesAt(lines, hunk, nominalStart + offset)) {
      return nominalStart + offset;
    }
  }

  // No fuzzy match found -- return nominal position so the apply step
  // will produce a precise error about which line mismatched
  return nominalStart;
}

/**
 * Check if all context and remove lines in a hunk match at the given position.
 */
function hunkMatchesAt(
  lines: string[],
  hunk: Hunk,
  startPos: number,
): boolean {
  if (startPos < 0) return false;

  let pos = startPos;
  for (const hunkLine of hunk.lines) {
    if (hunkLine.type === "context" || hunkLine.type === "remove") {
      if (pos >= lines.length || lines[pos] !== hunkLine.content) {
        return false;
      }
      pos++;
    }
    // "add" lines don't consume original lines
  }
  return true;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/tools/builtin/patch-applier.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/patch-applier.ts packages/core/src/tools/builtin/patch-applier.test.ts
git commit -m "feat(tools): add patch applier with hunk application and error checking"
```

---

### Task 4: Add fuzzy matching and new-file tests for patch applier

**Files:**
- Modify: `packages/core/src/tools/builtin/patch-applier.test.ts`

**Step 1: Add fuzzy matching and edge case tests**

Append inside the existing `describe("applyPatch", ...)` block:

```typescript
  it("applies hunk with fuzzy offset (lines shifted down)", () => {
    // Hunk says oldStart=2, but content is actually at line 4 (shifted by 2)
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 2,
          oldCount: 2,
          newStart: 2,
          newCount: 2,
          lines: [
            { type: "context", content: "target" },
            { type: "remove", content: "old" },
            { type: "add", content: "new" },
          ],
        },
      ],
    };

    // "target" is at line 4 (0-indexed: 3), hunk says line 2 (0-indexed: 1)
    // Offset is +2, within FUZZ_LIMIT of 3
    const original = "extra1\nextra2\ntarget\nold\nafter\n";
    const result = applyPatch(file, original);
    expect(result).toBe("extra1\nextra2\ntarget\nnew\nafter\n");
  });

  it("applies hunk with fuzzy offset (lines shifted up)", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 5,
          oldCount: 2,
          newStart: 5,
          newCount: 2,
          lines: [
            { type: "context", content: "target" },
            { type: "remove", content: "old" },
            { type: "add", content: "new" },
          ],
        },
      ],
    };

    // "target" is at line 3 (0-indexed: 2), hunk says line 5 (0-indexed: 4)
    // Offset is -2, within FUZZ_LIMIT of 3
    const original = "a\ntarget\nold\nafter\n";
    const result = applyPatch(file, original);
    expect(result).toBe("a\ntarget\nnew\nafter\n");
  });

  it("throws when fuzzy offset exceeds limit", () => {
    const file: PatchFile = {
      path: "test.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: "context", content: "target" },
          ],
        },
      ],
    };

    // "target" is at line 6 (0-indexed: 5), hunk says line 1 (0-indexed: 0)
    // Offset is +5, exceeds FUZZ_LIMIT of 3
    const original = "a\nb\nc\nd\ntarget\n";
    expect(() => applyPatch(file, original)).toThrow(/context mismatch/i);
  });

  it("applies to new file (empty content)", () => {
    const file: PatchFile = {
      path: "new-file.ts",
      hunks: [
        {
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: "add", content: "line1" },
            { type: "add", content: "line2" },
          ],
        },
      ],
    };

    const result = applyPatch(file, "");
    expect(result).toBe("line1\nline2\n");
  });

  it("applies complete file deletion", () => {
    const file: PatchFile = {
      path: "old-file.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 0,
          newCount: 0,
          lines: [
            { type: "remove", content: "line1" },
            { type: "remove", content: "line2" },
          ],
        },
      ],
    };

    const result = applyPatch(file, "line1\nline2\n");
    expect(result).toBe("\n");
  });
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/tools/builtin/patch-applier.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/core/src/tools/builtin/patch-applier.test.ts
git commit -m "test(tools): add fuzzy matching and edge case tests for patch applier"
```

---

### Task 5: Create the `apply_patch` tool

**Files:**
- Create: `packages/core/src/tools/builtin/apply-patch.ts`
- Create: `packages/core/src/tools/builtin/apply-patch.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/tools/builtin/apply-patch.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/tools/builtin/apply-patch.test.ts`
Expected: FAIL -- cannot find module `./apply-patch.js`

**Step 3: Write the implementation**

Create `packages/core/src/tools/builtin/apply-patch.ts`:

```typescript
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

      const isNewFile =
        patchFile.hunks.length > 0 &&
        patchFile.hunks[0].oldStart === 0 &&
        patchFile.hunks[0].oldCount === 0;

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
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/tools/builtin/apply-patch.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/apply-patch.ts packages/core/src/tools/builtin/apply-patch.test.ts
git commit -m "feat(tools): add apply_patch tool with atomic multi-file patching"
```

---

### Task 6: Register `apply_patch` in builtin tools index

**Files:**
- Modify: `packages/core/src/tools/builtin/index.ts`

**Step 1: Update the builtin index**

In `packages/core/src/tools/builtin/index.ts`, add the import and registration:

```typescript
import type { ToolHandler } from "../types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { webFetchTool } from "./web-fetch.js";
import { applyPatchTool } from "./apply-patch.js";

export {
  readTool,
  writeTool,
  editTool,
  bashTool,
  webFetchTool,
  applyPatchTool,
};

/** Creates an array of all built-in tool handlers. */
export function createBuiltinTools(): ToolHandler[] {
  return [readTool, writeTool, editTool, bashTool, webFetchTool, applyPatchTool];
}
```

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: SUCCESS -- no TypeScript errors

**Step 3: Commit**

```bash
git add packages/core/src/tools/builtin/index.ts
git commit -m "feat(tools): register apply_patch in builtin tools"
```

---

### Task 7: Update barrel exports

**Files:**
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Add `applyPatchTool` to the re-exports**

In `packages/core/src/tools/index.ts`, update the builtin re-exports (line 9-16):

```typescript
export {
  createBuiltinTools,
  readTool,
  writeTool,
  editTool,
  bashTool,
  webFetchTool,
  applyPatchTool,
} from "./builtin/index.js";
```

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Run all tests**

Run: `pnpm test`
Expected: ALL PASS -- no regressions

**Step 4: Commit**

```bash
git add packages/core/src/tools/index.ts
git commit -m "feat(tools): export applyPatchTool from @safeclaw/core"
```

---

### Task 8: Run full test suite and lint

**Step 1: Run all tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 2: Run linter**

Run: `pnpm lint`
Expected: No new errors

**Step 3: Run type check**

Run: `pnpm typecheck`
Expected: No errors

**Step 4: Final commit (if any lint/type fixes were needed)**

```bash
git add -A
git commit -m "chore(tools): fix lint and type issues in apply_patch"
```

Only commit if there were fixes. Skip if everything passed cleanly.

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `packages/core/src/tools/builtin/patch-parser.ts` | Unified diff parser → `PatchFile[]` |
| `packages/core/src/tools/builtin/patch-parser.test.ts` | Parser tests (9 cases) |
| `packages/core/src/tools/builtin/patch-applier.ts` | Hunk applier with fuzzy matching |
| `packages/core/src/tools/builtin/patch-applier.test.ts` | Applier tests (11 cases) |
| `packages/core/src/tools/builtin/apply-patch.ts` | `apply_patch` ToolHandler |
| `packages/core/src/tools/builtin/apply-patch.test.ts` | Tool integration tests (7 cases) |

## Modified Files

| File | Change |
|------|--------|
| `packages/core/src/tools/builtin/index.ts` | Import + register `applyPatchTool` |
| `packages/core/src/tools/index.ts` | Re-export `applyPatchTool` |
