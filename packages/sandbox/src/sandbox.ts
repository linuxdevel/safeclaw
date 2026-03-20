import { spawn } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxPolicy, SandboxResult, EnforcementLayers } from "./types.js";
import { assertSandboxSupported } from "./detect.js";
import { PolicyBuilder } from "./policy-builder.js";

/** POSIX single-quote shell escaping. Safe for all byte values. */
function shEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    if (!SandboxManager.isSandboxingEnabled()) {
      throw new Error(
        "SandboxManager is not initialized. Call SandboxManager.initialize() " +
          "before constructing a Sandbox (see bootstrapAgent()).",
      );
    }
    this.policy = policy;
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const start = performance.now();
    const timeout = this.policy.timeoutMs ?? 30_000;

    // Build the inner shell command. In Phase 1 the helper is not injected;
    // Task 8 adds `--policy-file` injection for Landlock + cap-drop.
    const shellCmd = [command, ...args].map(shEscape).join(" ");

    // Translate SafeClaw policy to sandbox-runtime config
    const rtConfig = PolicyBuilder.toRuntimeConfig(this.policy);

    // Wrap via sandbox-runtime (bwrap on Linux, sandbox-exec on macOS)
    const wrappedCmd = await SandboxManager.wrapWithSandbox(
      shellCmd,
      undefined,
      rtConfig,
    );

    const isLinux = process.platform === "linux";
    const enforcement: EnforcementLayers = {
      namespaces: isLinux,
      pivotRoot: isLinux,
      bindMounts: true,
      landlock: false,   // Phase 2: re-enabled when helper is injected
      seccomp: isLinux,  // sandbox-runtime applies seccomp for unix socket blocking on Linux
      capDrop: false,    // Phase 2: re-enabled when helper is injected
    };

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let killReason: "timeout" | "oom" | "signal" | undefined;

      const proc = spawn("/bin/sh", ["-c", wrappedCmd], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const timer = setTimeout(() => {
        killed = true;
        killReason = "timeout";
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
        // Clean up bwrap leftover mount points (no-op on macOS)
        SandboxManager.cleanupAfterCommand();
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
        SandboxManager.cleanupAfterCommand();
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
}
