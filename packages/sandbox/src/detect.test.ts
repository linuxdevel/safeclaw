import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs");

const mockedFs = vi.mocked(fs);

function mockKernel(release: string, status: string, nsFiles: string[]): void {
  mockedFs.readFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
    if (path === "/proc/sys/kernel/osrelease") return release;
    if (path === "/proc/self/status") return status;
    throw new Error(`Unexpected readFileSync: ${String(path)}`);
  });
  mockedFs.existsSync.mockImplementation((path: fs.PathLike) =>
    nsFiles.includes(String(path)),
  );
}

// Import after mock setup
const { detectKernelCapabilities, assertSandboxSupported } = await import(
  "./detect.js"
);

describe("detectKernelCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects Landlock support on kernel 6.1.0 with ABI v2", () => {
    mockKernel("6.1.0-generic\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    const caps = detectKernelCapabilities();
    expect(caps.landlock.supported).toBe(true);
    expect(caps.landlock.abiVersion).toBe(2);
  });

  it("detects Landlock ABI v3 on kernel 6.2.0", () => {
    mockKernel("6.2.0\n", "Seccomp:\t2\n", []);

    const caps = detectKernelCapabilities();
    expect(caps.landlock.supported).toBe(true);
    expect(caps.landlock.abiVersion).toBe(3);
  });

  it("detects Landlock ABI v1 on kernel 5.13.0", () => {
    mockKernel("5.13.0\n", "Seccomp:\t2\n", []);

    const caps = detectKernelCapabilities();
    expect(caps.landlock.supported).toBe(true);
    expect(caps.landlock.abiVersion).toBe(1);
  });

  it("reports no Landlock support on kernel 5.12.0", () => {
    mockKernel("5.12.0\n", "Seccomp:\t2\n", []);

    const caps = detectKernelCapabilities();
    expect(caps.landlock.supported).toBe(false);
    expect(caps.landlock.abiVersion).toBe(0);
  });

  it("detects seccomp from /proc/self/status containing Seccomp: 2", () => {
    mockKernel("6.1.0\n", "Name:\tnode\nSeccomp:\t2\nGroups:\t", []);

    const caps = detectKernelCapabilities();
    expect(caps.seccomp.supported).toBe(true);
  });

  it("detects seccomp mode 1 as supported", () => {
    mockKernel("6.1.0\n", "Seccomp:\t1\n", []);

    const caps = detectKernelCapabilities();
    expect(caps.seccomp.supported).toBe(true);
  });

  it("detects no seccomp when Seccomp: 0", () => {
    mockKernel("6.1.0\n", "Seccomp:\t0\n", []);

    const caps = detectKernelCapabilities();
    expect(caps.seccomp.supported).toBe(false);
  });

  it("detects missing namespace support when /proc/self/ns/user does not exist", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    const caps = detectKernelCapabilities();
    expect(caps.namespaces.user).toBe(false);
    expect(caps.namespaces.pid).toBe(true);
    expect(caps.namespaces.net).toBe(true);
    expect(caps.namespaces.mnt).toBe(true);
  });

  it("detects all namespaces present", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    const caps = detectKernelCapabilities();
    expect(caps.namespaces.user).toBe(true);
    expect(caps.namespaces.pid).toBe(true);
    expect(caps.namespaces.net).toBe(true);
    expect(caps.namespaces.mnt).toBe(true);
  });
});

describe("assertSandboxSupported", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws if kernel is 4.0.0 (no Landlock)", () => {
    mockKernel("4.0.0\n", "Seccomp:\t0\n", []);

    expect(() => assertSandboxSupported()).toThrow(
      /Missing kernel features.*Landlock/,
    );
  });

  it("throws listing all missing features", () => {
    mockKernel("4.0.0\n", "Seccomp:\t0\n", ["/proc/self/ns/mnt"]);

    expect(() => assertSandboxSupported()).toThrow(
      /Landlock.*seccomp-BPF.*User namespaces.*PID namespaces/,
    );
  });

  it("returns capabilities when all features present", () => {
    mockKernel("6.1.0\n", "Seccomp:\t2\n", [
      "/proc/self/ns/user",
      "/proc/self/ns/pid",
      "/proc/self/ns/net",
      "/proc/self/ns/mnt",
    ]);

    const caps = assertSandboxSupported();
    expect(caps.landlock.supported).toBe(true);
    expect(caps.seccomp.supported).toBe(true);
  });
});
