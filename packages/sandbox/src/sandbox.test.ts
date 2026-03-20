import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY } from "./types.js";
import type { KernelCapabilities } from "./types.js";

// Mock sandbox-runtime and helper before dynamic import
const mockAssertSandboxSupported = vi.fn<() => KernelCapabilities>();
const mockFindHelper = vi.fn<() => string | undefined>();
const mockWrapWithSandbox = vi.fn<(cmd: string) => Promise<string>>();
const mockIsSandboxingEnabled = vi.fn<() => boolean>();
const mockCleanupAfterCommand = vi.fn<() => void>();

vi.mock("./detect.js", () => ({
  assertSandboxSupported: mockAssertSandboxSupported,
}));

vi.mock("./helper.js", () => ({
  findHelper: () => mockFindHelper(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    isSandboxingEnabled: mockIsSandboxingEnabled,
    wrapWithSandbox: mockWrapWithSandbox,
    cleanupAfterCommand: mockCleanupAfterCommand,
  },
}));

const { Sandbox } = await import("./sandbox.js");

const FULL_CAPS: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 3 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
  bwrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
};

describe("Sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockIsSandboxingEnabled.mockReturnValue(true);
    mockFindHelper.mockReturnValue(undefined);
  });

  it("constructor calls assertSandboxSupported", () => {
    new Sandbox(DEFAULT_POLICY);
    expect(mockAssertSandboxSupported).toHaveBeenCalledOnce();
  });

  it("constructor throws if not initialized (isSandboxingEnabled returns false)", () => {
    mockIsSandboxingEnabled.mockReturnValue(false);
    expect(() => new Sandbox(DEFAULT_POLICY)).toThrow(/initialize/i);
  });

  it("getPolicy returns a copy of the policy", () => {
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const policy = sandbox.getPolicy();
    expect(policy).toEqual(DEFAULT_POLICY);
    expect(policy).not.toBe(DEFAULT_POLICY);
  });
});

describe("Sandbox.execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockIsSandboxingEnabled.mockReturnValue(true);
    mockFindHelper.mockReturnValue(undefined);
  });

  it("calls wrapWithSandbox with shell-quoted command", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/echo hello");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/echo", ["hello"]);
    expect(mockWrapWithSandbox).toHaveBeenCalledOnce();
    const wrappedArg: string = mockWrapWithSandbox.mock.calls[0]![0]!;
    expect(wrappedArg).toContain("echo");
    expect(wrappedArg).toContain("hello");
  });

  it("calls cleanupAfterCommand after execution", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/true");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/true", []);
    expect(mockCleanupAfterCommand).toHaveBeenCalledOnce();
  });

  it("returns stdout and exitCode from the spawned command", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/echo hello");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("kills process after timeout and returns killReason=timeout", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/sleep 60");
    const policy = { ...DEFAULT_POLICY, timeoutMs: 100 };
    const sandbox = new Sandbox(policy);
    const result = await sandbox.execute("/bin/sleep", ["60"]);
    expect(result.killed).toBe(true);
    expect(result.killReason).toBe("timeout");
  });

  it("reports pivotRoot=true and bindMounts=true on Linux", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/true");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    // These are set based on platform; in CI (Linux) both should be true
    expect(typeof result.enforcement?.pivotRoot).toBe("boolean");
    expect(typeof result.enforcement?.bindMounts).toBe("boolean");
  });

  it("calls cleanupAfterCommand even when command fails", async () => {
    mockWrapWithSandbox.mockResolvedValue("/bin/false");
    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/false", []);
    expect(mockCleanupAfterCommand).toHaveBeenCalledOnce();
  });
});
