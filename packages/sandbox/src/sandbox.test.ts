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

  it("execute throws not yet implemented", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);

    const sandbox = new Sandbox(DEFAULT_POLICY);

    await expect(sandbox.execute("echo", ["hello"])).rejects.toThrow(
      /not yet implemented/,
    );
  });
});
