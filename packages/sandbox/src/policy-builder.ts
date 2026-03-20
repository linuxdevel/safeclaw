import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxPolicy, PathRule, NetworkPolicy } from "./types.js";

/** Options for customizing the development policy */
export interface DevelopmentPolicyOptions {
  /** Additional paths that need execute access (e.g. ~/.cargo, ~/.rustup) */
  extraExecutePaths?: string[];
  /** Additional paths that need readwrite access (e.g. ~/.cache) */
  extraReadWritePaths?: string[];
  /** Additional read-only paths */
  extraReadOnlyPaths?: string[];
  /**
   * Network domains the sandboxed process may connect to.
   * Default: [] (block all network). Use this to allow e.g. npm registry.
   * Example: ["registry.npmjs.org", "*.github.com"]
   */
  allowedNetworkDomains?: string[];
}

/**
 * Builds a SandboxPolicy with a fluent API.
 *
 * Use `PolicyBuilder.forDevelopment(cwd)` to get a ready-made policy
 * for software development work (compilers, package managers, etc.).
 */
export class PolicyBuilder {
  private readonly allowRules: PathRule[] = [];
  private readonly denyRules: PathRule[] = [];
  private readonly syscalls: string[] = [];
  private readonly seenPaths = new Set<string>();

  addReadExecute(path: string): this {
    this.addRule(path, "execute");
    return this;
  }

  addReadWrite(path: string): this {
    this.addRule(path, "readwrite");
    return this;
  }

  addReadWriteExecute(path: string): this {
    this.addRule(path, "readwriteexecute");
    return this;
  }

  addReadOnly(path: string): this {
    this.addRule(path, "read");
    return this;
  }

  private addRule(path: string, access: PathRule["access"]): void {
    if (this.seenPaths.has(path)) return;
    this.seenPaths.add(path);
    this.allowRules.push({ path, access });
  }

  build(): SandboxPolicy {
    return {
      filesystem: {
        allow: [...this.allowRules],
        deny: [...this.denyRules],
      },
      syscalls: {
        allow: [...this.syscalls],
        defaultDeny: true as const,
      },
      network: "none",
      namespaces: { pid: true, net: true, mnt: true, user: true },
      timeoutMs: 30_000,
    };
  }

  /**
   * Translates a SafeClaw SandboxPolicy into a SandboxRuntimeConfig for
   * @anthropic-ai/sandbox-runtime.
   *
   * Read model difference: SafeClaw uses an allowlist (Landlock); sandbox-runtime
   * is permissive-by-default with an explicit denylist. We translate by denying
   * the sensitive credential dirs that must never be readable.
   *
   * Write model: both use allowlists. PathRules with access "readwrite" or
   * "readwriteexecute" map to filesystem.allowWrite.
   */
  static toRuntimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
    // ── Filesystem ────────────────────────────────────────────────────
    const allowWrite = policy.filesystem.allow
      .filter((r) => r.access === "readwrite" || r.access === "readwriteexecute")
      .map((r) => r.path);

    // Always deny reads to credential/secret directories.
    // sandbox-runtime also enforces mandatory deny on dangerous files (.bashrc,
    // .git/hooks, etc.) regardless of this config — these are complementary.
    const home = homedir();
    const denyRead = [
      `${home}/.ssh`,
      `${home}/.aws`,
      `${home}/.gnupg`,
      `${home}/.kube`,
      `${home}/.docker`,
      `${home}/.gcloud`,
      `${home}/.azure`,
    ];

    // ── Network ───────────────────────────────────────────────────────
    const network = buildNetworkConfig(policy.network);

    return {
      filesystem: {
        allowWrite,
        denyWrite: [],
        denyRead,
      },
      network,
    };
  }

  /**
   * Creates a policy suitable for software development.
   *
   * Grants:
   * - Read/write/execute access to CWD (compile + run binaries)
   * - Readwrite access to /tmp
   * - Execute access to standard command/library paths, compiler toolchains
   * - Read access to home directory (excluding sensitive dirs like ~/.ssh by omission)
   * - Read access to /etc, /proc/self, device nodes, headers, and support files
   * - Expanded syscall allowlist for common dev tools
   * - No network access (tools needing network run unsandboxed)
   */
  static forDevelopment(
    cwd: string,
    options?: DevelopmentPolicyOptions,
  ): SandboxPolicy {
    const builder = new PolicyBuilder();

    // ── Readwrite paths ──────────────────────────────────────────────
    // CWD gets readwriteexecute so compiled binaries can be run (./app)
    builder.addReadWriteExecute(cwd);
    builder.addReadWrite("/tmp");

    // ── Standard command locations (execute) ─────────────────────────
    builder.addReadExecute("/bin");
    builder.addReadExecute("/usr/bin");
    builder.addReadExecute("/usr/local/bin");
    builder.addReadExecute("/sbin");
    builder.addReadExecute("/usr/sbin");

    // ── Shared libraries (execute) ───────────────────────────────────
    builder.addReadExecute("/usr/lib");
    builder.addReadExecute("/usr/lib64");
    builder.addReadExecute("/usr/local/lib");
    builder.addReadExecute("/usr/local/lib64");
    builder.addReadExecute("/lib");
    builder.addReadExecute("/lib64");

    // ── Compiler and toolchain paths (execute) ───────────────────────
    // JDK installations (javac, java, jar, etc.)
    builder.addReadExecute("/usr/lib/jvm");
    // GCC internal libraries, specs, and cc1/cc1plus
    builder.addReadExecute("/usr/lib/gcc");
    // Compiler/linker helper binaries (e.g. ld, as wrappers)
    builder.addReadExecute("/usr/libexec");
    builder.addReadExecute("/usr/local/libexec");

    // ── Node.js install path ─────────────────────────────────────────
    // process.execPath is e.g. /home/user/.nvm/versions/node/v22.0.0/bin/node
    // We need the grandparent directory for the full installation
    const nodeInstallDir = dirname(dirname(process.execPath));
    builder.addReadExecute(nodeInstallDir);

    // ── Read-only paths ──────────────────────────────────────────────
    // Home directory: read-only for dotfiles, configs, etc.
    // Sensitive dirs like ~/.ssh are NOT added — Landlock denies by default.
    builder.addReadOnly(homedir());

    builder.addReadOnly("/etc");
    builder.addReadOnly("/proc/self");

    // C/C++ system headers
    builder.addReadOnly("/usr/include");
    builder.addReadOnly("/usr/local/include");

    // Compiler support files, man pages, locale data
    builder.addReadOnly("/usr/share");
    builder.addReadOnly("/usr/local/share");

    // Device nodes
    builder.addReadWrite("/dev/null");
    builder.addReadOnly("/dev/urandom");
    builder.addReadOnly("/dev/zero");

    // ── Extra paths from options ─────────────────────────────────────
    if (options?.extraExecutePaths) {
      for (const p of options.extraExecutePaths) {
        builder.addReadExecute(p);
      }
    }
    if (options?.extraReadWritePaths) {
      for (const p of options.extraReadWritePaths) {
        builder.addReadWrite(p);
      }
    }
    if (options?.extraReadOnlyPaths) {
      for (const p of options.extraReadOnlyPaths) {
        builder.addReadOnly(p);
      }
    }

    // ── Expanded syscall allowlist ───────────────────────────────────
    // Includes all DEFAULT_POLICY syscalls plus what common dev tools need
    for (const sc of DEVELOPMENT_SYSCALLS) {
      builder.syscalls.push(sc);
    }

    // ── Network ──────────────────────────────────────────────────────
    const networkPolicy: NetworkPolicy =
      options?.allowedNetworkDomains !== undefined
        ? { allowedDomains: options.allowedNetworkDomains }
        : "none";

    return { ...builder.build(), network: networkPolicy };
  }
}

function buildNetworkConfig(
  network: NetworkPolicy,
): SandboxRuntimeConfig["network"] {
  if (network === "none") {
    return { allowedDomains: [], deniedDomains: [] };
  }
  if (network === "localhost") {
    return { allowedDomains: ["localhost"], deniedDomains: [] };
  }
  return {
    allowedDomains: network.allowedDomains,
    deniedDomains: network.deniedDomains ?? [],
  };
}

/**
 * Syscalls needed for typical development tool execution.
 * This is the DEFAULT_POLICY set plus everything needed by:
 * Node.js, git, pnpm, gcc, javac, rustc, go, make, and common CLI tools.
 */
const DEVELOPMENT_SYSCALLS: readonly string[] = [
  // ── Process lifecycle ──────────────────────────────────────────────
  "exit",
  "exit_group",
  "clone",
  "clone3",
  "execve",
  "execveat",
  "wait4",
  "waitid",
  "vfork",
  "kill",
  "tgkill",
  "getpid",
  "getppid",
  "gettid",
  "getuid",
  "getgid",
  "geteuid",
  "getegid",
  "getgroups",
  "getpgrp",
  "prctl",
  "arch_prctl",
  "set_tid_address",
  "set_robust_list",
  "capget",
  "setresuid",
  "setresgid",

  // ── Memory management ──────────────────────────────────────────────
  "brk",
  "mmap",
  "mprotect",
  "munmap",
  "mremap",
  "madvise",
  "memfd_create",

  // ── File operations ────────────────────────────────────────────────
  "read",
  "write",
  "open",
  "openat",
  "close",
  "fstat",
  "stat",
  "lstat",
  "newfstatat",
  "statx",
  "access",
  "faccessat2",
  "readlink",
  "readlinkat",
  "getdents64",
  "lseek",
  "pread64",
  "pwrite64",
  "readv",
  "writev",
  "fcntl",
  "ioctl",
  "truncate",
  "ftruncate",

  // ── File modification ──────────────────────────────────────────────
  "rename",
  "renameat",
  "renameat2",
  "mkdir",
  "mkdirat",
  "rmdir",
  "unlink",
  "unlinkat",
  "symlink",
  "symlinkat",
  "chmod",
  "fchmod",
  "fchmodat",
  "chown",
  "fchown",
  "lchown",
  "umask",
  "utimensat",
  "fallocate",
  "flock",

  // ── Directory navigation ───────────────────────────────────────────
  "getcwd",
  "chdir",
  "fchdir",

  // ── Pipes and IPC ──────────────────────────────────────────────────
  "pipe",
  "pipe2",
  "dup",
  "dup2",
  "dup3",
  "close_range",
  "copy_file_range",
  "sendfile",
  "splice",
  "tee",

  // ── Signals ────────────────────────────────────────────────────────
  "rt_sigaction",
  "rt_sigprocmask",
  "rt_sigreturn",
  "rt_sigtimedwait",
  "rt_sigqueueinfo",
  "sigaltstack",

  // ── Socket operations (for IPC, not network — Landlock controls net) ──
  "socket",
  "connect",
  "sendto",
  "recvfrom",
  "sendmsg",
  "recvmsg",
  "bind",
  "listen",
  "accept4",
  "socketpair",
  "getsockname",
  "getpeername",
  "setsockopt",
  "getsockopt",
  "shutdown",

  // ── Polling and events ─────────────────────────────────────────────
  "poll",
  "ppoll",
  "select",
  "pselect6",
  "epoll_create1",
  "epoll_ctl",
  "epoll_wait",
  "epoll_pwait",
  "eventfd2",
  "inotify_init1",
  "inotify_add_watch",
  "inotify_rm_watch",
  "timerfd_create",
  "timerfd_settime",
  "timerfd_gettime",
  "signalfd4",

  // ── Time ───────────────────────────────────────────────────────────
  "clock_gettime",
  "clock_getres",
  "clock_nanosleep",
  "gettimeofday",
  "nanosleep",
  "alarm",
  "setitimer",
  "getitimer",
  "times",

  // ── System info ────────────────────────────────────────────────────
  "uname",
  "sysinfo",
  "statfs",
  "fstatfs",
  "getrlimit",
  "setrlimit",
  "prlimit64",
  "getrusage",
  "sched_getaffinity",
  "sched_yield",
  "getrandom",
  "rseq",

  // ── io_uring (used by modern Node.js and tools) ────────────────────
  "io_uring_setup",
  "io_uring_enter",
  "io_uring_register",

  // ── Threading / futex ──────────────────────────────────────────────
  "futex",

  // ── Misc (needed by Node.js, compilers, linkers) ───────────────────
  "openat2",
  "mknod",
  "restart_syscall",
];
