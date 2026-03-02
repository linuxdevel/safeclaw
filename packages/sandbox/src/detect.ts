import { readFileSync, existsSync } from "node:fs";
import type { KernelCapabilities } from "./types.js";

const LANDLOCK_MIN_KERNEL: [number, number] = [5, 13];

function parseKernelVersion(release: string): [number, number] {
  const parts = release.trim().split(".");
  return [parseInt(parts[0] ?? "0", 10), parseInt(parts[1] ?? "0", 10)];
}

function kernelAtLeast(release: string, min: [number, number]): boolean {
  const [major, minor] = parseKernelVersion(release);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

export function detectKernelCapabilities(): KernelCapabilities {
  const release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
  const status = readFileSync("/proc/self/status", "utf8");

  const landlockSupported = kernelAtLeast(release, LANDLOCK_MIN_KERNEL);
  let landlockAbi = 0;
  if (landlockSupported) {
    const [major, minor] = parseKernelVersion(release);
    if (major > 6 || (major === 6 && minor >= 2)) landlockAbi = 3;
    else if (major > 5 || (major === 5 && minor >= 19)) landlockAbi = 2;
    else landlockAbi = 1;
  }

  const seccompSupported = /Seccomp:\s*[12]/.test(status);

  return {
    landlock: { supported: landlockSupported, abiVersion: landlockAbi },
    seccomp: { supported: seccompSupported },
    namespaces: {
      user: existsSync("/proc/self/ns/user"),
      pid: existsSync("/proc/self/ns/pid"),
      net: existsSync("/proc/self/ns/net"),
      mnt: existsSync("/proc/self/ns/mnt"),
    },
  };
}

export function assertSandboxSupported(): KernelCapabilities {
  const caps = detectKernelCapabilities();
  const missing: string[] = [];
  if (!caps.landlock.supported)
    missing.push("Landlock (requires kernel >= 5.13)");
  if (!caps.seccomp.supported) missing.push("seccomp-BPF");
  if (!caps.namespaces.user) missing.push("User namespaces");
  if (!caps.namespaces.pid) missing.push("PID namespaces");

  if (missing.length > 0) {
    throw new Error(
      `SafeClaw requires mandatory sandbox support. Missing kernel features: ${missing.join(", ")}. ` +
        `SafeClaw v1 is Linux-only and requires a modern kernel (>= 5.13).`,
    );
  }
  return caps;
}
