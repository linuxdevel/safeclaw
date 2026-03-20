import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { KernelCapabilities } from "./types.js";

/**
 * Probes system capabilities relevant to sandboxing.
 * Returns KernelCapabilities with bwrap probe on Linux; on macOS the
 * bwrap fields are always unavailable (macOS uses sandbox-exec instead).
 */
export function detectKernelCapabilities(): KernelCapabilities {
  let bwrapPath: string | undefined;
  let bwrapVersion: string | undefined;

  try {
    bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
    try {
      bwrapVersion = execFileSync("bwrap", ["--version"], { encoding: "utf8" })
        .trim()
        .split("\n")[0];
    } catch {
      // version flag not supported or bwrap not runnable — path is still valid
    }
  } catch {
    // bwrap not on PATH
  }

  // Landlock / seccomp / namespace detection is Linux-only; on macOS these
  // are undefined/false since sandbox-runtime uses sandbox-exec there.
  const isLinux = process.platform === "linux";

  return {
    landlock: {
      supported: isLinux ? detectLandlock() : false,
      abiVersion: isLinux ? detectLandlockAbi() : 0,
    },
    seccomp: { supported: isLinux ? detectSeccomp() : false },
    namespaces: {
      user: isLinux ? existsSync("/proc/self/ns/user") : false,
      pid:  isLinux ? existsSync("/proc/self/ns/pid")  : false,
      net:  isLinux ? existsSync("/proc/self/ns/net")  : false,
      mnt:  isLinux ? existsSync("/proc/self/ns/mnt")  : false,
    },
    bwrap: {
      available: bwrapPath !== undefined,
      path: bwrapPath,
      version: bwrapVersion,
    },
  };
}

/**
 * Throws a descriptive error if the current platform and dependencies
 * do not support sandbox-runtime isolation.
 */
export function assertSandboxSupported(): KernelCapabilities {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(
      `SafeClaw sandbox is not supported on this platform (${process.platform}). ` +
        `Supported: Linux (kernel ≥ 5.13, bubblewrap, socat, ripgrep) and macOS.`,
    );
  }

  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    throw new Error(
      `Sandbox dependencies missing: ${deps.errors.join(", ")}. ` +
        `On Linux install: apt install bubblewrap socat ripgrep`,
    );
  }

  return detectKernelCapabilities();
}

// ── Linux helpers ──────────────────────────────────────────────────────

const LANDLOCK_MIN_KERNEL: [number, number] = [5, 13];

function parseKernelVersion(release: string): [number, number] {
  const parts = release.trim().split(".");
  return [parseInt(parts[0] ?? "0", 10), parseInt(parts[1] ?? "0", 10)];
}

function detectLandlock(): boolean {
  try {
    const release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
    const [major, minor] = parseKernelVersion(release);
    return (
      major > LANDLOCK_MIN_KERNEL[0] ||
      (major === LANDLOCK_MIN_KERNEL[0] && minor >= LANDLOCK_MIN_KERNEL[1])
    );
  } catch {
    return false;
  }
}

function detectLandlockAbi(): number {
  try {
    const release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
    const [major, minor] = parseKernelVersion(release);
    if (major > 6 || (major === 6 && minor >= 2)) return 3;
    if (major > 5 || (major === 5 && minor >= 19)) return 2;
    if (major > 5 || (major === 5 && minor >= 13)) return 1;
    return 0;
  } catch {
    return 0;
  }
}

function detectSeccomp(): boolean {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    return /Seccomp:\s*[12]/.test(status);
  } catch {
    return false;
  }
}
