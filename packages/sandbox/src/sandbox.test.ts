import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { DEFAULT_POLICY } from "./types.js";
import type { KernelCapabilities } from "./types.js";

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

const mockAssertSandboxSupported = vi.fn<() => KernelCapabilities>();
const mockFindHelper = vi.fn<() => string | undefined>();

vi.mock("./detect.js", () => ({
  assertSandboxSupported: mockAssertSandboxSupported,
}));

vi.mock("./helper.js", () => ({
  findHelper: (...args: unknown[]) => mockFindHelper(),
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
    mockFindHelper.mockReturnValue(undefined);
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
    mockFindHelper.mockReturnValue(undefined);
  });

  it.skipIf(!canUnshareUser)(
    "runs a command and returns stdout",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      const sandbox = new Sandbox(DEFAULT_POLICY);
      const result = await sandbox.execute("/bin/echo", ["hello"]);
      expect(result.stdout).toContain("hello");
      expect(result.exitCode).toBe(0);
      expect(result.killed).toBe(false);
    },
  );

  it.skipIf(!canUnshareUser)(
    "returns non-zero exit code on failure",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      const sandbox = new Sandbox(DEFAULT_POLICY);
      const result = await sandbox.execute("/bin/false", []);
      expect(result.exitCode).not.toBe(0);
      expect(result.killed).toBe(false);
    },
  );

  it.skipIf(!canUnshareUser)(
    "kills process after timeout",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      const policy = { ...DEFAULT_POLICY, timeoutMs: 100 };
      const sandbox = new Sandbox(policy);
      const result = await sandbox.execute("/bin/sleep", ["10"]);
      expect(result.killed).toBe(true);
      expect(result.killReason).toBe("timeout");
    },
  );

  it.skipIf(!canUnshareUser)("captures stderr", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/sh", ["-c", "echo error >&2"]);
    expect(result.stderr).toContain("error");
  });

  it.skipIf(!canUnshareUser)("reports durationMs", async () => {
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!canUnshareUser)(
    "mount namespace isolates filesystem changes from host",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      const policy = {
        ...DEFAULT_POLICY,
        namespaces: { pid: false, net: false, mnt: true, user: true },
      };
      const sandbox = new Sandbox(policy);
      const result = await sandbox.execute("/bin/sh", [
        "-c",
        "cat /proc/self/mounts | wc -l",
      ]);
      expect(result.exitCode).toBe(0);
      expect(parseInt(result.stdout.trim(), 10)).toBeGreaterThan(0);
    },
  );

  it.skipIf(!canUnshareUser)(
    "blocks network access in network namespace",
    async () => {
      mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
      const policy = {
        ...DEFAULT_POLICY,
        namespaces: { pid: false, net: true, mnt: false, user: true },
      };
      const sandbox = new Sandbox(policy);
      const result = await sandbox.execute("/bin/sh", [
        "-c",
        "ip link show 2>/dev/null | grep -oP '(?<=: )\\w+(?=:)' | sort",
      ]);
      expect(result.stdout.trim()).toBe("lo");
      expect(result.exitCode).toBe(0);
    },
  );
});

describe("Sandbox.execute() helper integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSandboxSupported.mockReturnValue(FULL_CAPS);
    mockFindHelper.mockReturnValue(undefined);
  });

  it("sets enforcement.namespaces=true even without helper", async () => {
    mockFindHelper.mockReturnValue(undefined);

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);

    expect(result.exitCode).toBe(0);
    expect(result.enforcement).toBeDefined();
    expect(result.enforcement!.namespaces).toBe(true);
    expect(result.enforcement!.landlock).toBe(false);
    expect(result.enforcement!.seccomp).toBe(false);
    expect(result.enforcement!.capDrop).toBe(false);
  });

  it("sets full enforcement when helper is found", async () => {
    mockFindHelper.mockReturnValue("/usr/local/bin/safeclaw-sandbox-helper");

    const sandbox = new Sandbox(DEFAULT_POLICY);
    const result = await sandbox.execute("/bin/true", []);

    expect(result.enforcement).toBeDefined();
    expect(result.enforcement!.namespaces).toBe(true);
    expect(result.enforcement!.landlock).toBe(true);
    expect(result.enforcement!.seccomp).toBe(true);
    expect(result.enforcement!.capDrop).toBe(true);
  });
});
