import { lstatSync, realpathSync } from "node:fs";

function realpathSyncOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxPolicy, PathRule, NetworkPolicy } from "./types.js";
import { DANGEROUS_SYSCALLS } from "./types.js";

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
        deny: [...DANGEROUS_SYSCALLS],
        defaultAllow: true as const,
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

    // Always deny reads to credential/secret paths that exist.
    // Non-existent paths are skipped — bwrap cannot bind-mount over them.
    const home = homedir();
    const denyReadCandidates = [
      // ── Cloud provider credentials ──────────────────────────────────
      join(home, ".ssh"),
      join(home, ".aws"),
      join(home, ".gnupg"),
      join(home, ".kube"),
      join(home, ".docker"),
      join(home, ".gcloud"),
      join(home, ".config", "gcloud"),
      join(home, ".azure"),
      join(home, ".config", "azure"),

      // ── Git & VCS ───────────────────────────────────────────────────
      join(home, ".git-credentials"),
      join(home, ".netrc"),

      // ── Package manager credentials ─────────────────────────────────
      join(home, ".npmrc"),
      join(home, ".cargo", "credentials"),
      join(home, ".cargo", "credentials.toml"),
      join(home, ".pypirc"),
      join(home, ".m2", "settings.xml"),
      join(home, ".gradle", "gradle.properties"),
      join(home, ".gem", "credentials"),

      // ── PaaS / SaaS CLI credentials ─────────────────────────────────
      join(home, ".config", "gh"),
      join(home, ".config", "hub"),
      join(home, ".config", "heroku"),
      join(home, ".fly"),
      join(home, ".config", "flyctl"),
      join(home, ".vercel"),
      join(home, ".config", "netlify"),
      join(home, ".config", "op"),         // 1Password CLI
      join(home, ".config", "doctl"),
      join(home, ".vault-token"),
      join(home, ".terraform.d", "credentials.tfrc.json"),

      // ── Password managers & secrets ─────────────────────────────────
      join(home, ".password-store"),
      join(home, ".1password"),
      join(home, ".lastpass"),
      join(home, ".bitwarden"),

      // ── Database credentials ─────────────────────────────────────────
      join(home, ".pgpass"),
      join(home, ".my.cnf"),
      join(home, ".myclirc"),

      // ── Shell history ────────────────────────────────────────────────
      join(home, ".bash_history"),
      join(home, ".zsh_history"),
      join(home, ".sh_history"),

      // ── AI agent configs (skill-worm / prompt-injection prevention) ──
      join(home, ".claude"),
      join(home, ".config", "claude"),
      join(home, ".anthropic"),
      join(home, ".safeclaw"),             // protect vault + own config
    ];

    const denyRead = denyReadCandidates.filter((p) => {
      try {
        lstatSync(p);
        // Resolve symlinks: skip paths that resolve outside the local
        // filesystem (e.g. WSL2 symlinks pointing into /mnt/c/...).
        // bwrap bind-mounts the local root read-only but does not include
        // /mnt/*, so --tmpfs over a symlink target under /mnt fails.
        try {
          const real = realpathSyncOrNull(p);
          if (real !== null && real.startsWith("/mnt/")) return false;
        } catch {
          return false; // broken symlink or unresolvable path
        }
        return true;
      } catch {
        return false;
      }
    });

    // Protect shell init files and git config from writes even if the
    // sandbox allows writing to the home directory.
    const denyWrite = [
      join(home, ".bashrc"),
      join(home, ".bash_profile"),
      join(home, ".bash_login"),
      join(home, ".zshrc"),
      join(home, ".zprofile"),
      join(home, ".profile"),
      join(home, ".gitconfig"),
      join(home, ".ssh", "authorized_keys"),
      join(home, ".ssh", "config"),
    ].filter((p) => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    });

    // ── Network ───────────────────────────────────────────────────────
    const network = buildNetworkConfig(policy.network);

    return {
      filesystem: {
        allowWrite,
        denyWrite,
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
   * - Seccomp denylist for dangerous kernel/privilege syscalls (default allow)
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

