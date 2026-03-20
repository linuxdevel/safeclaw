/** Filesystem access rule for Landlock */
export interface PathRule {
  path: string;
  access: "read" | "write" | "readwrite" | "execute" | "readwriteexecute";
}

/**
 * Network policy for a sandbox execution.
 * - "none": block all outbound network (net namespace, no proxy)
 * - "localhost": allow only loopback
 * - object: route through sandbox-runtime proxy with domain allowlist/denylist
 */
export type NetworkPolicy =
  | "none"
  | "localhost"
  | { allowedDomains: string[]; deniedDomains?: string[] };

/** Sandbox policy — defines isolation constraints for a single execution */
export interface SandboxPolicy {
  filesystem: { allow: PathRule[]; deny: PathRule[] };
  syscalls: { allow: string[]; defaultDeny: true };
  network: NetworkPolicy;
  namespaces: { pid: boolean; net: boolean; mnt: boolean; user: boolean };
  timeoutMs?: number | undefined;
}

/** Which enforcement layers were active during execution */
export interface EnforcementLayers {
  namespaces: boolean;
  pivotRoot: boolean;    // bwrap pivot_root was used
  bindMounts: boolean;   // bwrap bind-mount FS isolation was active
  landlock: boolean;
  seccomp: boolean;
  capDrop: boolean;
}

/** Result of a sandboxed execution */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  killReason?: "timeout" | "oom" | "signal" | undefined;
  enforcement?: EnforcementLayers | undefined;
}

/** Kernel feature availability */
export interface KernelCapabilities {
  landlock: { supported: boolean; abiVersion: number };
  seccomp: { supported: boolean };
  namespaces: { user: boolean; pid: boolean; net: boolean; mnt: boolean };
  bwrap: { available: boolean; path: string | undefined; version: string | undefined };
}

/** Default sandbox policy — maximum restriction */
export const DEFAULT_POLICY: SandboxPolicy = {
  filesystem: { allow: [], deny: [] },
  syscalls: {
    allow: [
      "read",
      "write",
      "exit",
      "exit_group",
      "brk",
      "mmap",
      "close",
      "fstat",
      "mprotect",
      "munmap",
      "rt_sigaction",
      "rt_sigprocmask",
      "ioctl",
      "access",
      "getpid",
      "clone",
      "execve",
      "wait4",
      "uname",
      "fcntl",
      "getcwd",
      "arch_prctl",
      "set_tid_address",
      "set_robust_list",
      "rseq",
      "prlimit64",
      "getrandom",
    ],
    defaultDeny: true,
  },
  network: "none",
  namespaces: { pid: true, net: true, mnt: true, user: true },
  timeoutMs: 30_000,
};
