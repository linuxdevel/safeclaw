import { spawn } from "node:child_process";
import type { SandboxPolicy, SandboxResult } from "./types.js";
import { assertSandboxSupported } from "./detect.js";

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
    const spawnCmd = useUnshare ? "unshare" : command;
    const spawnArgs = useUnshare
      ? [...unshareFlags, "--", command, ...args]
      : args;

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn(spawnCmd, spawnArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

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

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          durationMs: performance.now() - start,
          killed,
          killReason,
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
