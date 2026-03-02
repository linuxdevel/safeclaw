import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";

vi.mock("node:fs");
vi.mock("node:child_process");

const mockedFs = vi.mocked(fs);
const mockedCp = vi.mocked(childProcess);

const { findHelper } = await import("./helper.js");

describe("findHelper", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env["SAFECLAW_HELPER_PATH"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns SAFECLAW_HELPER_PATH when set and file is executable", () => {
    process.env["SAFECLAW_HELPER_PATH"] = "/custom/path/helper";
    mockedFs.accessSync.mockImplementation((path) => {
      if (path === "/custom/path/helper") return undefined;
      throw new Error("ENOENT");
    });

    const result = findHelper();
    expect(result).toBe("/custom/path/helper");
  });

  it("falls through when SAFECLAW_HELPER_PATH file doesn't exist", () => {
    process.env["SAFECLAW_HELPER_PATH"] = "/nonexistent/helper";
    mockedFs.accessSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockedCp.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = findHelper();
    expect(result).toBeUndefined();
  });

  it("returns co-located path when file exists there", () => {
    // No env var set — should check co-located path
    mockedFs.accessSync.mockImplementation((path) => {
      if (String(path).endsWith("native/safeclaw-sandbox-helper")) {
        return undefined;
      }
      throw new Error("ENOENT");
    });

    const result = findHelper();
    expect(result).toBeDefined();
    expect(result).toMatch(/native\/safeclaw-sandbox-helper$/);
  });

  it("returns installed path when file exists at ~/.safeclaw/bin/", () => {
    const home = process.env["HOME"] ?? "/home/test";
    const installedPath = `${home}/.safeclaw/bin/safeclaw-sandbox-helper`;

    mockedFs.accessSync.mockImplementation((path) => {
      if (path === installedPath) return undefined;
      throw new Error("ENOENT");
    });
    mockedCp.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = findHelper();
    expect(result).toBe(installedPath);
  });

  it("returns undefined when helper is not found anywhere", () => {
    mockedFs.accessSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockedCp.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = findHelper();
    expect(result).toBeUndefined();
  });
});
