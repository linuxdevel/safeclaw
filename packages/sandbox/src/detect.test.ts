import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsSupportedPlatform = vi.fn<() => boolean>();
const mockCheckDeps = vi.fn<() => { errors: string[]; warnings: string[] }>();
const mockWhichBwrap = vi.fn<() => string>();

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    isSupportedPlatform: mockIsSupportedPlatform,
    checkDependencies: mockCheckDeps,
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockWhichBwrap,
}));

const { detectKernelCapabilities, assertSandboxSupported } = await import("./detect.js");

describe("detectKernelCapabilities()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports bwrap available when which bwrap succeeds", () => {
    mockWhichBwrap.mockReturnValue("/usr/bin/bwrap");
    const caps = detectKernelCapabilities();
    expect(caps.bwrap.available).toBe(true);
    expect(caps.bwrap.path).toBe("/usr/bin/bwrap");
  });

  it("reports bwrap unavailable when which bwrap fails", () => {
    mockWhichBwrap.mockImplementation(() => { throw new Error("not found"); });
    const caps = detectKernelCapabilities();
    expect(caps.bwrap.available).toBe(false);
    expect(caps.bwrap.path).toBeUndefined();
  });
});

describe("assertSandboxSupported()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not throw when platform is supported and deps are OK", () => {
    mockIsSupportedPlatform.mockReturnValue(true);
    mockCheckDeps.mockReturnValue({ errors: [], warnings: [] });
    mockWhichBwrap.mockReturnValue("/usr/bin/bwrap");
    expect(() => assertSandboxSupported()).not.toThrow();
  });

  it("throws when platform is not supported", () => {
    mockIsSupportedPlatform.mockReturnValue(false);
    mockCheckDeps.mockReturnValue({ errors: [], warnings: [] });
    expect(() => assertSandboxSupported()).toThrow(/platform/i);
  });

  it("throws when sandbox-runtime deps are missing", () => {
    mockIsSupportedPlatform.mockReturnValue(true);
    mockCheckDeps.mockReturnValue({ errors: ["bubblewrap not found"], warnings: [] });
    expect(() => assertSandboxSupported()).toThrow(/bubblewrap not found/);
  });
});
