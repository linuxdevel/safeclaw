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
  syscalls: { deny: string[]; defaultAllow: true };
  network: NetworkPolicy;
  namespaces: { pid: boolean; net: boolean; mnt: boolean; user: boolean };
  timeoutMs?: number | undefined;
}

/**
 * Syscalls that are always denied regardless of policy mode.
 * These are kernel/privilege-escalation syscalls that no sandboxed
 * development process should ever need.
 */
export const DANGEROUS_SYSCALLS: readonly string[] = [
  // Kernel module loading
  "init_module",
  "finit_module",
  "delete_module",
  // System reboot / power management
  "kexec_load",
  "kexec_file_load",
  "reboot",
  "swapon",
  "swapoff",
  // Namespace / container escape
  "mount",
  "umount2",
  "pivot_root",
  "chroot",
  "setns",
  // Kernel tracing / BPF (privilege escalation vectors)
  "ptrace",
  "bpf",
  "perf_event_open",
  "userfaultfd",
  // Kernel keyring (credential theft)
  "add_key",
  "request_key",
  "keyctl",
  // Raw hardware I/O port access (privilege escalation on x86)
  "ioperm",
  "iopl",
];

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

/** Default sandbox policy — deny dangerous syscalls, allow everything else */
export const DEFAULT_POLICY: SandboxPolicy = {
  filesystem: { allow: [], deny: [] },
  syscalls: {
    deny: [...DANGEROUS_SYSCALLS],
    defaultAllow: true,
  },
  network: "none",
  namespaces: { pid: true, net: true, mnt: true, user: true },
  timeoutMs: 30_000,
};
