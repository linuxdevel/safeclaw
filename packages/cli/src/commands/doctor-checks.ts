import type { DiagnosticCheck, DiagnosticResult } from "./doctor-types.js";
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";
import { execFileSync as defaultExecFileSync } from "node:child_process";
import { findHelper as defaultFindHelper } from "@safeclaw/sandbox";
import {
  detectKernelCapabilities as defaultDetectKernelCapabilities,
} from "@safeclaw/sandbox";
import type { KernelCapabilities } from "@safeclaw/sandbox";
import { readFileSync as defaultReadFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// System checks
// ---------------------------------------------------------------------------

export interface NodeVersionDeps {
  version: string;
}

export function nodeVersionCheck(
  deps: NodeVersionDeps = { version: process.version },
): DiagnosticCheck {
  return {
    name: "node-version",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      // process.version is "vX.Y.Z"
      const raw = deps.version.replace(/^v/, "");
      const major = parseInt(raw.split(".")[0] ?? "0", 10);
      if (major >= 22) {
        return { status: "pass", message: `Node.js ${raw}` };
      }
      return {
        status: "fail",
        message: `Node.js ${raw} is too old`,
        detail: "SafeClaw requires Node.js >= 22.",
      };
    },
  };
}

export interface PlatformDeps {
  platform: string;
}

export function platformCheck(
  deps: PlatformDeps = { platform: process.platform },
): DiagnosticCheck {
  const supported = new Set(["linux", "darwin"]);
  return {
    name: "platform",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      if (supported.has(deps.platform)) {
        return { status: "pass", message: `Platform: ${deps.platform}` };
      }
      return {
        status: "fail",
        message: `Unsupported platform: ${deps.platform}`,
        detail: "SafeClaw supports Linux and macOS (darwin) only.",
      };
    },
  };
}

export interface ArchDeps {
  arch: string;
}

export function architectureCheck(
  deps: ArchDeps = { arch: process.arch },
): DiagnosticCheck {
  const supported = new Set(["x64", "arm64"]);
  return {
    name: "architecture",
    category: "system",
    async run(): Promise<DiagnosticResult> {
      if (supported.has(deps.arch)) {
        return { status: "pass", message: `Architecture: ${deps.arch}` };
      }
      return {
        status: "fail",
        message: `Unsupported architecture: ${deps.arch}`,
        detail: "SafeClaw supports x86_64 (x64) and arm64 only.",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Config checks
// ---------------------------------------------------------------------------

export interface VaultExistsDeps {
  existsSync: (path: string) => boolean;
  homedir: string;
}

export function vaultExistsCheck(
  deps: VaultExistsDeps = {
    existsSync: defaultExistsSync,
    homedir: defaultHomedir(),
  },
): DiagnosticCheck {
  return {
    name: "vault-exists",
    category: "config",
    async run(): Promise<DiagnosticResult> {
      const vaultPath = join(deps.homedir, ".safeclaw", "vault.json");
      if (deps.existsSync(vaultPath)) {
        return { status: "pass", message: `Vault found: ${vaultPath}` };
      }
      return {
        status: "warn",
        message: "Vault not found",
        detail: `Expected at ${vaultPath}. Run 'safeclaw onboard' to create it.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

export interface SandboxHelperDeps {
  findHelper: () => string | undefined;
}

export function sandboxHelperCheck(
  deps: SandboxHelperDeps = { findHelper: defaultFindHelper },
): DiagnosticCheck {
  return {
    name: "sandbox-helper",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      const helperPath = deps.findHelper();
      if (helperPath !== undefined) {
        return {
          status: "pass",
          message: `Sandbox helper: ${helperPath}`,
        };
      }
      return {
        status: "warn",
        message: "Sandbox helper not found",
        detail:
          "The native sandbox helper binary is not installed. " +
          "Run 'make -C native' to build it, or sandbox enforcement will be limited.",
      };
    },
  };
}

export interface BwrapDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function bwrapCheck(
  deps: BwrapDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "bwrap",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const path = deps.execFileSync("which", ["bwrap"]).trim();
        return { status: "pass", message: `bwrap available: ${path}` };
      } catch {
        return {
          status: "fail",
          message: "bwrap not found",
          detail:
            "bubblewrap (bwrap) is required for sandbox isolation. " +
            "Install: apt install bubblewrap",
        };
      }
    },
  };
}

export interface SocatDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function socatCheck(
  deps: SocatDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "socat",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const path = deps.execFileSync("which", ["socat"]).trim();
        return { status: "pass", message: `socat available: ${path}` };
      } catch {
        return {
          status: "warn",
          message: "socat not found",
          detail:
            "socat is used by sandbox-runtime for network proxying. " +
            "Without it, network domain filtering will not work. " +
            "Install: apt install socat",
        };
      }
    },
  };
}

export interface RipgrepDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function ripgrepCheck(
  deps: RipgrepDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "ripgrep",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const path = deps.execFileSync("which", ["rg"]).trim();
        return { status: "pass", message: `rg available: ${path}` };
      } catch {
        return {
          status: "warn",
          message: "rg (ripgrep) not found",
          detail:
            "ripgrep is used by the search tool for fast code search. " +
            "Install: apt install ripgrep",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Kernel security checks
// ---------------------------------------------------------------------------

export interface KernelCapsDeps {
  detectKernelCapabilities: () => KernelCapabilities;
}

const defaultKernelDeps: KernelCapsDeps = {
  detectKernelCapabilities: defaultDetectKernelCapabilities,
};

export function landlockCheck(
  deps: KernelCapsDeps = defaultKernelDeps,
): DiagnosticCheck {
  return {
    name: "landlock",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const caps = deps.detectKernelCapabilities();
        if (caps.landlock.supported) {
          return {
            status: "pass",
            message: `Landlock supported (ABI v${caps.landlock.abiVersion})`,
          };
        }
        return {
          status: "fail",
          message: "Landlock not supported",
          detail: "Landlock requires kernel >= 5.13.",
        };
      } catch {
        return {
          status: "fail",
          message: "Could not detect Landlock support",
          detail: "Failed to read kernel capabilities.",
        };
      }
    },
  };
}

export function seccompCheck(
  deps: KernelCapsDeps = defaultKernelDeps,
): DiagnosticCheck {
  return {
    name: "seccomp",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const caps = deps.detectKernelCapabilities();
        if (caps.seccomp.supported) {
          return { status: "pass", message: "seccomp-BPF supported" };
        }
        return {
          status: "fail",
          message: "seccomp-BPF not supported",
          detail: "seccomp is required for syscall filtering.",
        };
      } catch {
        return {
          status: "fail",
          message: "Could not detect seccomp support",
          detail: "Failed to read kernel capabilities.",
        };
      }
    },
  };
}

export function userNamespaceCheck(
  deps: KernelCapsDeps = defaultKernelDeps,
): DiagnosticCheck {
  return {
    name: "user-namespaces",
    category: "security",
    async run(): Promise<DiagnosticResult> {
      try {
        const caps = deps.detectKernelCapabilities();
        if (caps.namespaces.user) {
          return { status: "pass", message: "User namespaces available" };
        }
        return {
          status: "fail",
          message: "User namespaces unavailable",
          detail:
            "User namespace support is required for unprivileged sandbox isolation. " +
            "Check: sysctl kernel.unprivileged_userns_clone=1",
        };
      } catch {
        return {
          status: "fail",
          message: "Could not detect namespace support",
          detail: "Failed to read kernel capabilities.",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Connectivity checks
// ---------------------------------------------------------------------------

export interface KeyringDeps {
  execFileSync: (cmd: string, args: string[]) => string;
}

export function keyringCheck(
  deps: KeyringDeps = {
    execFileSync: (cmd: string, args: string[]) =>
      defaultExecFileSync(cmd, args, { encoding: "utf8" }),
  },
): DiagnosticCheck {
  return {
    name: "keyring",
    category: "config",
    async run(): Promise<DiagnosticResult> {
      try {
        deps.execFileSync("which", ["secret-tool"]);
        return { status: "pass", message: "secret-tool (GNOME Keyring) available" };
      } catch {
        return {
          status: "warn",
          message: "secret-tool not found",
          detail:
            "GNOME Keyring integration unavailable. " +
            "Vault will fall back to passphrase-based key derivation. " +
            "Install: apt install libsecret-tools",
        };
      }
    },
  };
}

export interface ConfigFileDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  homedir: string;
}

export function configFileCheck(
  deps: ConfigFileDeps = {
    existsSync: defaultExistsSync,
    readFileSync: (p: string) =>
      defaultReadFileSync(p, "utf8"),
    homedir: defaultHomedir(),
  },
): DiagnosticCheck {
  return {
    name: "config-file",
    category: "config",
    async run(): Promise<DiagnosticResult> {
      const configPath = join(deps.homedir, ".safeclaw", "safeclaw.json");
      if (!deps.existsSync(configPath)) {
        return {
          status: "pass",
          message: "Config file not present (optional)",
        };
      }
      try {
        const content = deps.readFileSync(configPath);
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return {
            status: "fail",
            message: "Config file is not a JSON object",
            detail: `${configPath} must contain a JSON object.`,
          };
        }
        return {
          status: "pass",
          message: `Config file valid: ${configPath}`,
        };
      } catch (err) {
        return {
          status: "fail",
          message: "Config file contains invalid JSON",
          detail: `${configPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

export interface GithubConnectivityDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function githubConnectivityCheck(
  deps: GithubConnectivityDeps = { fetch: globalThis.fetch },
): DiagnosticCheck {
  return {
    name: "github-connectivity",
    category: "connectivity",
    async run(): Promise<DiagnosticResult> {
      try {
        const response = await deps.fetch("https://api.github.com", {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return { status: "pass", message: "GitHub API reachable" };
        }
        return {
          status: "warn",
          message: `GitHub API returned HTTP ${response.status}`,
          detail:
            "api.github.com is reachable but returned a non-OK status. " +
            "Copilot authentication may not work.",
        };
      } catch (err) {
        return {
          status: "warn",
          message: "Cannot reach GitHub API",
          detail:
            `Could not connect to api.github.com: ${err instanceof Error ? err.message : String(err)}. ` +
            "Copilot features require internet connectivity.",
        };
      }
    },
  };
}
