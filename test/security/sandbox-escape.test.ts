import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { DEFAULT_POLICY } from "@safeclaw/sandbox";
import type { SandboxPolicy, KernelCapabilities } from "@safeclaw/sandbox";

/**
 * Probe whether user namespaces work on this machine.
 * GitHub Actions runners and some containers restrict unprivileged
 * user namespaces, causing `unshare --user` to fail.
 */
let canUnshareUser = false;
try {
  execFileSync("unshare", ["--user", "--map-root-user", "--", "/bin/true"], {
    timeout: 3000,
  });
  canUnshareUser = true;
} catch {
  // user namespaces not available — skip dependent tests
}

const UNSUPPORTED_CAPS: KernelCapabilities = {
  landlock: { supported: false, abiVersion: 0 },
  seccomp: { supported: false },
  namespaces: { user: false, pid: false, net: false, mnt: false },
  bwrap: { available: false, path: undefined, version: undefined },
};

const FULL_CAPS: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 3 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
  bwrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
};

const mockAssert = vi.fn<() => KernelCapabilities>();

// Mock the internal detect module that Sandbox actually imports from.
// We must mock the concrete file path (not the package entry point) because
// Sandbox imports detect.js directly. The real detectKernelCapabilities reads
// /proc/sys and invokes prctl(2), which are unavailable in test/CI environments.
vi.mock("../../packages/sandbox/src/detect.js", () => ({
  detectKernelCapabilities: () => UNSUPPORTED_CAPS,
  assertSandboxSupported: (...args: []) => mockAssert(...args),
}));

vi.mock("../../packages/sandbox/src/helper.js", () => ({
  findHelper: () => undefined,
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    isSandboxingEnabled: () => true,
    wrapWithSandbox: async (cmd: string) => cmd,
    cleanupAfterCommand: () => undefined,
  },
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
      (policy as SandboxPolicy).network = "localhost";

      const policyAgain = sandbox.getPolicy();
      expect(policyAgain.network).toBe("none");
    });

    it("mutating nested objects in returned policy does not affect sandbox", () => {
      mockAssert.mockReturnValue(FULL_CAPS);

      const sandbox = new Sandbox(DEFAULT_POLICY);
      const policy = sandbox.getPolicy();
      policy.filesystem.allow.push({ path: "/etc", access: "read" });
      const policyAgain = sandbox.getPolicy();
      expect(policyAgain.filesystem.allow).toEqual([]);
    });
  });

  describe("execute() enforces sandbox policy", () => {
    it.skipIf(!canUnshareUser)(
      "returns a result with stdout and exitCode",
      async () => {
        mockAssert.mockReturnValue(FULL_CAPS);

        const sandbox = new Sandbox(DEFAULT_POLICY);
        const result = await sandbox.execute("/bin/echo", ["hello"]);

        expect(result.stdout).toContain("hello");
        expect(result.exitCode).toBe(0);
        expect(result.killed).toBe(false);
        expect(result.killReason).toBeUndefined();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      },
    );

    it.skipIf(!canUnshareUser)(
      "enforces timeout — kills long-running processes",
      async () => {
        mockAssert.mockReturnValue(FULL_CAPS);

        const policy = { ...DEFAULT_POLICY, timeoutMs: 100 };
        const sandbox = new Sandbox(policy);
        const result = await sandbox.execute("/bin/sleep", ["10"]);

        expect(result.killed).toBe(true);
        expect(result.killReason).toBe("timeout");
      },
    );
  });
});
