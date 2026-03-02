import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs");

const mockedFs = vi.mocked(fs);

function mockStat(mode: number): fs.Stats {
  return { mode } as fs.Stats;
}

// Import after mock setup
const { assertFilePermissions, assertDirectoryPermissions, PermissionError } =
  await import("./permissions.js");

describe("assertFilePermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts mode 0o600 for files", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o100600));
    expect(() => assertFilePermissions("/tmp/vault.json")).not.toThrow();
  });

  it("rejects mode 0o644 for files", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o100644));
    expect(() => assertFilePermissions("/tmp/vault.json")).toThrow(
      PermissionError,
    );
  });

  it("rejects mode 0o666 for files", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o100666));
    expect(() => assertFilePermissions("/tmp/vault.json")).toThrow(
      PermissionError,
    );
  });

  it("includes path and modes in error message", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o100644));
    try {
      assertFilePermissions("/tmp/vault.json");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionError);
      const err = e as InstanceType<typeof PermissionError>;
      expect(err.message).toContain("/tmp/vault.json");
      expect(err.message).toContain("0644");
      expect(err.message).toContain("0600");
    }
  });
});

describe("assertDirectoryPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts mode 0o700 for directories", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o040700));
    expect(() => assertDirectoryPermissions("/tmp/vault")).not.toThrow();
  });

  it("rejects mode 0o755 for directories", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o040755));
    expect(() => assertDirectoryPermissions("/tmp/vault")).toThrow(
      PermissionError,
    );
  });

  it("includes fix command in error message", () => {
    mockedFs.statSync.mockReturnValue(mockStat(0o040755));
    try {
      assertDirectoryPermissions("/tmp/vault");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionError);
      const err = e as InstanceType<typeof PermissionError>;
      expect(err.message).toContain("chmod");
    }
  });
});
