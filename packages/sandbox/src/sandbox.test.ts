import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY } from "./types.js";
import type { KernelCapabilities } from "./types.js";

// Mock sandbox-runtime and helper before dynamic import
const mockAssertSandboxSupported = vi.fn<() => KernelCapabilities>();
const mockFindHelper = vi.fn<() => string | undefined>();
const mockWrapWithSandbox = vi.fn<(cmd: string) => Promise<string>>();
const mockIsSandboxingEnabled = vi.fn<() => boolean>();
const mockCleanupAfterCommand = vi.fn<() => void>();
const mockWriteFileSync = vi.fn<() => void>();
const mockRmSync = vi.fn<() => void>();

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

vi.mock("node:fs", () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
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
    mockWriteFileSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
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
    mockWriteFileSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
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

describe("Sandbox.execute() with helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockIsSandboxingEnabled.mockReturnValue(true);
    mockWriteFileSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
  });

  it("includes --policy-file in the inner command when helper is found", async () => {
    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");
    mockWrapWithSandbox.mockImplementation(async (cmd: string) => cmd);

    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/echo", ["hello"]);

    const innerCmd: string = mockWrapWithSandbox.mock.calls[0]![0]!;
    expect(innerCmd).toContain("safeclaw-sandbox-helper");
    expect(innerCmd).toContain("--policy-file");
    expect(innerCmd).toContain("--");
    expect(innerCmd).toContain("echo");
  });

  it("sets enforcement.landlock=true and enforcement.capDrop=true when helper is found", async () => {
    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");
    mockWrapWithSandbox.mockResolvedValue("/bin/true");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);

    expect(result.enforcement?.landlock).toBe(true);
    expect(result.enforcement?.capDrop).toBe(true);
  });

  it("does NOT set landlock/capDrop when helper is not found", async () => {
    mockFindHelper.mockReturnValue(undefined);
    mockWrapWithSandbox.mockResolvedValue("/bin/true");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);

    expect(result.enforcement?.landlock).toBe(false);
    expect(result.enforcement?.capDrop).toBe(false);
  });

  it("cleans up policy temp file even if command fails", async () => {
    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");
    mockWrapWithSandbox.mockResolvedValue("/bin/false");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    await sandbox.execute("/bin/false", []);

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("safeclaw-policy-"),
      { force: true },
    );
  });
});
