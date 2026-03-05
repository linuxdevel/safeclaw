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
});
