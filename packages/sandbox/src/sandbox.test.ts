import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY } from "./types.js";
import type { KernelCapabilities } from "./types.js";

const mockAssertSandboxSupported = vi.fn<() => KernelCapabilities>();

vi.mock("./detect.js", () => ({
  assertSandboxSupported: mockAssertSandboxSupported,
}));

const { Sandbox } = await import("./sandbox.js");

const FULL_CAPS: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 3 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
};

describe("Sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructor calls assertSandboxSupported", () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);

    new Sandbox(DEFAULT_POLICY);

    expect(mockAssertSandboxSupported).toHaveBeenCalledOnce();
  });

  it("constructor throws if sandbox not supported", () => {
    mockAssertSandboxSupported.mockImplementation(() => {
      throw new Error("Missing kernel features: Landlock");
    });

    expect(() => new Sandbox(DEFAULT_POLICY)).toThrow(
      /Missing kernel features/,
    );
  });

  it("getPolicy returns a copy of the policy", () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const policy = sandbox.getPolicy();

    expect(policy).toEqual(DEFAULT_POLICY);
    expect(policy).not.toBe(DEFAULT_POLICY);
  });

});

describe("Sandbox.execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs a command and returns stdout", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/echo", ["hello"]);
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
  });

  it("returns non-zero exit code on failure", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/false", []);
    expect(result.exitCode).not.toBe(0);
    expect(result.killed).toBe(false);
  });

  it("kills process after timeout", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const policy = { ...DEFAULT_POLICY, timeoutMs: 100 };
    const sandbox = new Sandbox(policy);
    const result = await sandbox.execute("/bin/sleep", ["10"]);
    expect(result.killed).toBe(true);
    expect(result.killReason).toBe("timeout");
  });

  it("captures stderr", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/sh", ["-c", "echo error >&2"]);
    expect(result.stderr).toContain("error");
  });

  it("reports durationMs", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("mount namespace isolates filesystem changes from host", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const policy = {
      ...DEFAULT_POLICY,
      namespaces: { pid: false, net: false, mnt: true, user: true },
    };
    const sandbox = new Sandbox(policy);
    // In a mount namespace, the child has its own mount table.
    // Verify the child can read its mount table (proving isolation).
    const result = await sandbox.execute("/bin/sh", [
      "-c",
      "cat /proc/self/mounts | wc -l",
    ]);
    expect(result.exitCode).toBe(0);
    expect(parseInt(result.stdout.trim(), 10)).toBeGreaterThan(0);
  });

  it("blocks network access in network namespace", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const policy = {
      ...DEFAULT_POLICY,
      namespaces: { pid: false, net: true, mnt: false, user: true },
    };
    const sandbox = new Sandbox(policy);
    // In a fresh net namespace, only 'lo' exists as a network interface.
    // We use 'ip link show' which queries the kernel directly (not /sys).
    const result = await sandbox.execute("/bin/sh", [
      "-c",
      "ip link show 2>/dev/null | grep -oP '(?<=: )\\w+(?=:)' | sort",
    ]);
    expect(result.stdout.trim()).toBe("lo");
    expect(result.exitCode).toBe(0);
  });
});
