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
    const line = lines[i] as string;

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
