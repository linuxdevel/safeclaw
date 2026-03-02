/** Filesystem access rule for Landlock */
export interface PathRule {
  path: string;
  access: "read" | "write" | "readwrite" | "execute";
}

/** Sandbox policy — defines isolation constraints for a single execution */
export interface SandboxPolicy {
  filesystem: { allow: PathRule[]; deny: PathRule[] };
  syscalls: { allow: string[]; defaultDeny: true };
  network: "none" | "localhost" | "filtered";
  namespaces: { pid: boolean; net: boolean; mnt: boolean; user: boolean };
  timeoutMs?: number | undefined;
}

/** Result of a sandboxed execution */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  killReason?: "timeout" | "oom" | "signal" | undefined;
}

/** Kernel feature availability */
export interface KernelCapabilities {
  landlock: { supported: boolean; abiVersion: number };
  seccomp: { supported: boolean };
  namespaces: { user: boolean; pid: boolean; net: boolean; mnt: boolean };
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
