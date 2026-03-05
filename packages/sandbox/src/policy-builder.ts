import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxPolicy, PathRule } from "./types.js";

/** Options for customizing the development policy */
export interface DevelopmentPolicyOptions {
  /** Additional paths that need execute access (e.g. ~/.cargo, ~/.rustup) */
  extraExecutePaths?: string[];
  /** Additional paths that need readwrite access (e.g. ~/.cache) */
  extraReadWritePaths?: string[];
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
   * Creates a policy suitable for software development.
   *
   * Grants:
   * - Readwrite access to CWD, /tmp, and ~/.safeclaw
   * - Execute access to standard command/library paths, compiler toolchains
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
    builder.addReadWrite(cwd);
    builder.addReadWrite("/tmp");
    builder.addReadWrite(join(homedir(), ".safeclaw"));

    // ── Standard command locations (execute) ─────────────────────────
    builder.addReadExecute("/bin");
    builder.addReadExecute("/usr/bin");
    builder.addReadExecute("/usr/local/bin");

    // ── Shared libraries (execute) ───────────────────────────────────
    builder.addReadExecute("/usr/lib");
    builder.addReadExecute("/lib");
    builder.addReadExecute("/lib64");

    // ── Compiler and toolchain paths (execute) ───────────────────────
    // JDK installations (javac, java, jar, etc.)
    builder.addReadExecute("/usr/lib/jvm");
    // GCC internal libraries, specs, and cc1/cc1plus
    builder.addReadExecute("/usr/lib/gcc");
    // Compiler/linker helper binaries (e.g. ld, as wrappers)
    builder.addReadExecute("/usr/libexec");

    // ── Node.js install path ─────────────────────────────────────────
    // process.execPath is e.g. /home/user/.nvm/versions/node/v22.0.0/bin/node
    // We need the grandparent directory for the full installation
    const nodeInstallDir = dirname(dirname(process.execPath));
    builder.addReadExecute(nodeInstallDir);

    // ── Read-only paths ──────────────────────────────────────────────
    builder.addReadOnly("/etc");
    builder.addReadOnly("/proc/self");

    // C/C++ system headers
    builder.addReadOnly("/usr/include");

    // Compiler support files, man pages, locale data
    builder.addReadOnly("/usr/share");

    // Device nodes
    builder.addReadOnly("/dev/null");
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

    // ── Expanded syscall allowlist ───────────────────────────────────
    // Includes all DEFAULT_POLICY syscalls plus what common dev tools need
    for (const sc of DEVELOPMENT_SYSCALLS) {
      builder.syscalls.push(sc);
    }

    return builder.build();
  }
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
  "kill",
  "tgkill",
  "getpid",
  "getppid",
  "getuid",
  "getgid",
  "geteuid",
  "getegid",
  "getgroups",
  "prctl",
  "arch_prctl",
  "set_tid_address",
  "set_robust_list",

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
  "openat",
  "close",
  "fstat",
  "stat",
  "lstat",
  "newfstatat",
  "statx",
  "access",
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

  // ── Directory navigation ───────────────────────────────────────────
  "getcwd",
  "chdir",
  "fchdir",

  // ── Pipes and IPC ──────────────────────────────────────────────────
  "pipe",
  "pipe2",
  "dup",
  "dup2",
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
];
