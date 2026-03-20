import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxPolicy, SandboxResult, EnforcementLayers } from "./types.js";
import { assertSandboxSupported } from "./detect.js";
import { findHelper } from "./helper.js";
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

    // Inject C helper (Landlock + seccomp + cap-drop) as the inner process
    // when the helper binary is available, using --policy-file for the policy.
    const helperPath = findHelper();
    const useHelper = helperPath !== undefined;

    let policyTmpPath: string | undefined;
    let innerCmd: string;

    if (useHelper) {
      // Write policy JSON to a temp file (mode 0600, as required by policy_read_file).
      policyTmpPath = join(
        tmpdir(),
        `safeclaw-policy-${process.pid.toString()}-${Date.now().toString()}.json`,
      );
      writeFileSync(
        policyTmpPath,
        JSON.stringify({
          filesystem: this.policy.filesystem,
          syscalls: this.policy.syscalls,
        }),
        { mode: 0o600 },
      );
      innerCmd = [
        helperPath,
        "--policy-file",
        policyTmpPath,
        "--",
        command,
        ...args,
      ]
        .map(shEscape)
        .join(" ");
    } else {
      innerCmd = [command, ...args].map(shEscape).join(" ");
    }

    // Translate SafeClaw policy to sandbox-runtime config. When helper is
    // present and in a non-system path, add its directory to allowWrite so
    // bwrap bind-mounts it into the container.
    const rtConfig = PolicyBuilder.toRuntimeConfig(this.policy);
    if (useHelper && helperPath !== undefined) {
      const helperDir = helperPath.substring(0, helperPath.lastIndexOf("/"));
      const systemPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];
      if (!systemPaths.includes(helperDir)) {
        rtConfig.filesystem.allowWrite = [
          ...rtConfig.filesystem.allowWrite,
          helperDir,
        ];
      }
    }

    // Wrap via sandbox-runtime (bwrap on Linux, sandbox-exec on macOS)
    const wrappedCmd = await SandboxManager.wrapWithSandbox(
      innerCmd,
      undefined,
      rtConfig,
    );

    const isLinux = process.platform === "linux";
    const enforcement: EnforcementLayers = {
      namespaces: isLinux,
      pivotRoot: isLinux,
      bindMounts: true,
      landlock: useHelper,
      seccomp: isLinux,  // sandbox-runtime applies seccomp for unix socket blocking on Linux
      capDrop: useHelper,
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
        if (policyTmpPath !== undefined) {
          try { rmSync(policyTmpPath, { force: true }); } catch { /* ignore */ }
        }
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
        if (policyTmpPath !== undefined) {
          try { rmSync(policyTmpPath, { force: true }); } catch { /* ignore */ }
        }
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
