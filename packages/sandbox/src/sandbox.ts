import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { SandboxPolicy, SandboxResult, EnforcementLayers } from "./types.js";
import { assertSandboxSupported } from "./detect.js";
import { findHelper } from "./helper.js";

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    this.policy = policy;
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const start = performance.now();
    const timeout = this.policy.timeoutMs ?? 30_000;

    // Build unshare flags from policy namespace settings
    const unshareFlags = this.buildUnshareFlags();

    // If we have unshare flags, wrap: unshare [flags] -- command [args]
    // Otherwise run directly
    const useUnshare = unshareFlags.length > 0;

    // Resolve helper binary
    // TODO: Re-add SHA-256 integrity verification once builds are reproducible
    const helperPath = findHelper();
    const useHelper = helperPath !== undefined;

    // Build enforcement metadata
    const enforcement: EnforcementLayers = {
      namespaces: useUnshare,
      landlock: useHelper,
      seccomp: useHelper,
      capDrop: useHelper,
    };

    // Build spawn command and args based on available isolation
    let spawnCmd: string;
    let spawnArgs: string[];
    let stdio: ("ignore" | "pipe")[];

    if (useUnshare && helperPath !== undefined) {
      spawnCmd = "unshare";
      spawnArgs = [...unshareFlags, "--", helperPath, "--", command, ...args];
      stdio = ["ignore", "pipe", "pipe", "pipe"];
    } else if (useUnshare) {
      spawnCmd = "unshare";
      spawnArgs = [...unshareFlags, "--", command, ...args];
      stdio = ["ignore", "pipe", "pipe"];
    } else if (helperPath !== undefined) {
      spawnCmd = helperPath;
      spawnArgs = ["--", command, ...args];
      stdio = ["ignore", "pipe", "pipe", "pipe"];
    } else {
      spawnCmd = command;
      spawnArgs = args;
      stdio = ["ignore", "pipe", "pipe"];
    }

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn(spawnCmd, spawnArgs, {
        stdio,
        detached: true,
      });

      // Write policy JSON to fd 3 when using helper
      if (useHelper) {
        const fd3 = proc.stdio[3] as Writable;
        fd3.on("error", () => {
          // Ignored: the child may exit before reading fd 3
        });
        const policyJson = JSON.stringify({
          filesystem: this.policy.filesystem,
          syscalls: this.policy.syscalls,
        });
        fd3.end(policyJson);
      }

      const timer = setTimeout(() => {
        killed = true;
        killReason = "timeout";
        // Kill entire process group (unshare + forked children)
        if (proc.pid !== undefined) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        } else {
          proc.kill("SIGKILL");
        }
      }, timeout);

      proc.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          durationMs: performance.now() - start,
          killed,
          killReason,
          enforcement,
        });
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: err.message,
          durationMs: performance.now() - start,
          killed: false,
          enforcement,
        });
      });
    });
  }

  getPolicy(): SandboxPolicy {
    return structuredClone(this.policy);
  }

  private buildUnshareFlags(): string[] {
    const flags: string[] = [];
    const ns = this.policy.namespaces;

    if (ns.pid) flags.push("--pid", "--fork");
    if (ns.net) flags.push("--net");
    if (ns.mnt) flags.push("--mount");
    if (ns.user) flags.push("--user", "--map-root-user");

    return flags;
  }
}
