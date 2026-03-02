import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY } from "@safeclaw/sandbox";
import type { SandboxPolicy, KernelCapabilities } from "@safeclaw/sandbox";

const UNSUPPORTED_CAPS: KernelCapabilities = {
  landlock: { supported: false, abiVersion: 0 },
  seccomp: { supported: false },
  namespaces: { user: false, pid: false, net: false, mnt: false },
};

const FULL_CAPS: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 3 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
};

const mockAssert = vi.fn<() => KernelCapabilities>();

// Mock the internal detect module that Sandbox actually imports from
vi.mock("../../packages/sandbox/src/detect.js", () => ({
  detectKernelCapabilities: () => UNSUPPORTED_CAPS,
  assertSandboxSupported: (...args: []) => mockAssert(...args),
}));

const { Sandbox } = await import("@safeclaw/sandbox");

describe("Sandbox escape prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fail-closed on missing kernel capabilities", () => {
    it("constructor calls assertSandboxSupported and propagates failures", () => {
      mockAssert.mockImplementation(() => {
        throw new Error(
          "SafeClaw requires mandatory sandbox support. Missing kernel features: Landlock (requires kernel >= 5.13), seccomp-BPF",
        );
      });

      expect(() => new Sandbox(DEFAULT_POLICY)).toThrow(
        /Missing kernel features/,
      );
      expect(mockAssert).toHaveBeenCalledOnce();
    });

    it("constructor succeeds when kernel capabilities are present", () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      expect(() => new Sandbox(DEFAULT_POLICY)).not.toThrow();
      expect(mockAssert).toHaveBeenCalledOnce();
    });
  });

  describe("DEFAULT_POLICY is maximally restrictive", () => {
    it("uses defaultDeny: true for syscalls", () => {
      expect(DEFAULT_POLICY.syscalls.defaultDeny).toBe(true);
    });

    it("blocks all network access", () => {
      expect(DEFAULT_POLICY.network).toBe("none");
    });

    it("enables all namespace isolation", () => {
      expect(DEFAULT_POLICY.namespaces).toEqual({
        pid: true,
        net: true,
        mnt: true,
        user: true,
      });
    });

    it("has empty filesystem allow and deny lists", () => {
      expect(DEFAULT_POLICY.filesystem.allow).toEqual([]);
      expect(DEFAULT_POLICY.filesystem.deny).toEqual([]);
    });
  });

  describe("getPolicy returns a defensive copy", () => {
    it("returns a copy, not the original reference", () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const sandbox = new Sandbox(DEFAULT_POLICY);
      const policy = sandbox.getPolicy();

      expect(policy).toEqual(DEFAULT_POLICY);
      expect(policy).not.toBe(DEFAULT_POLICY);
    });

    it("mutating the returned policy does not affect the sandbox", () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const sandbox = new Sandbox(DEFAULT_POLICY);
      const policy = sandbox.getPolicy();
      (policy as SandboxPolicy).network = "filtered";

      const policyAgain = sandbox.getPolicy();
      expect(policyAgain.network).toBe("none");
    });
  });

  describe("execute() is a stub that cannot be bypassed", () => {
    it("throws 'not yet implemented' on execute()", async () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const sandbox = new Sandbox(DEFAULT_POLICY);
      await expect(sandbox.execute("echo", ["hello"])).rejects.toThrow(
        /not yet implemented/,
      );
    });

    it("throws even for empty command", async () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const sandbox = new Sandbox(DEFAULT_POLICY);
      await expect(sandbox.execute("", [])).rejects.toThrow(
        /not yet implemented/,
      );
    });
  });
});
