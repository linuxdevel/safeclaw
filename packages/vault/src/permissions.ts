import { statSync } from "node:fs";

export class PermissionError extends Error {
  constructor(
    path: string,
    actual: number,
    expected: number,
  ) {
    const actualOctal = actual.toString(8).padStart(4, "0");
    const expectedOctal = expected.toString(8).padStart(4, "0");
    super(
      `Unsafe permissions on ${path}: mode is ${actualOctal}, expected ${expectedOctal}. ` +
        `Fix with: chmod ${expectedOctal} ${path}`,
    );
    this.name = "PermissionError";
  }
}

/**
 * Throws PermissionError if file mode bits are not 0o600 (owner read/write only).
 */
export function assertFilePermissions(path: string): void {
  const stats = statSync(path);
  const modeBits = stats.mode & 0o777;
  if (modeBits !== 0o600) {
    throw new PermissionError(path, modeBits, 0o600);
  }
}

/**
 * Throws PermissionError if directory mode bits are not 0o700 (owner rwx only).
 */
export function assertDirectoryPermissions(path: string): void {
  const stats = statSync(path);
  const modeBits = stats.mode & 0o777;
  if (modeBits !== 0o700) {
    throw new PermissionError(path, modeBits, 0o700);
  }
}
