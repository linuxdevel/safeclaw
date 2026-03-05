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
  for (const hunkLine of hunk.lines) {
    if (hunkLine.type === "context") {
      if (readPos >= lines.length || lines[readPos] !== hunkLine.content) {
        throw new Error(
          `Context mismatch at line ${readPos + 1}: expected "${hunkLine.content}", got "${lines[readPos] ?? "EOF"}"`,
        );
      }
      newLines.push(lines[readPos]!);
      readPos++;
    } else if (hunkLine.type === "remove") {
      if (readPos >= lines.length || lines[readPos] !== hunkLine.content) {
        throw new Error(
          `Remove line mismatch at line ${readPos + 1}: expected "${hunkLine.content}", got "${lines[readPos] ?? "EOF"}"`,
        );
      }
      readPos++;
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
