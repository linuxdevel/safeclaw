import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface ProcessStatus {
  id: string;
  pid: number | undefined;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  duration: number;
}

interface TrackedProcess {
  id: string;
  child: ChildProcess;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  output: string[];
  outputBytes: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB per process
const MAX_CONCURRENT = 8;
const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_AGE_MS = 3_600_000;

export class ProcessManager {
  private readonly processes = new Map<string, TrackedProcess>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  start(command: string, options?: { cwd?: string }): string {
    if (!command || typeof command !== "string") {
      throw new Error("Required argument 'command' must be a non-empty string");
    }

    const runningCount = [...this.processes.values()].filter(
      (p) => p.running,
    ).length;
    if (runningCount >= MAX_CONCURRENT) {
      throw new Error(
        `Max concurrent process limit reached (${MAX_CONCURRENT})`,
      );
    }

    const id = randomUUID();
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tracked: TrackedProcess = {
      id,
      child,
      running: true,
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      output: [],
      outputBytes: 0,
    };

    const appendOutput = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      tracked.output.push(text);
      tracked.outputBytes += text.length;

      while (tracked.outputBytes > MAX_OUTPUT_BYTES && tracked.output.length > 1) {
        const removed = tracked.output.shift()!;
        tracked.outputBytes -= removed.length;
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.on("close", (code: number | null) => {
      tracked.running = false;
      tracked.exitCode = code;
      tracked.finishedAt = Date.now();
    });

    this.processes.set(id, tracked);
    return id;
  }

  status(id: string): ProcessStatus {
    const tracked = this.processes.get(id);
    if (!tracked) {
      throw new Error(`Process not found: "${id}"`);
    }
    return this.toStatus(tracked);
  }

  log(id: string, options?: { tail?: number }): string {
    const tracked = this.processes.get(id);
    if (!tracked) {
      throw new Error(`Process not found: "${id}"`);
    }

    const fullOutput = tracked.output.join("");
    if (!fullOutput) return "";

    if (options?.tail !== undefined && options.tail > 0) {
      const lines = fullOutput.trimEnd().split("\n");
      return lines.slice(-options.tail).join("\n") + "\n";
    }

    return fullOutput;
  }

  kill(id: string, signal?: string): boolean {
    const tracked = this.processes.get(id);
    if (!tracked) {
      throw new Error(`Process not found: "${id}"`);
    }
    if (!tracked.running) {
      return false;
    }
    return tracked.child.kill((signal as NodeJS.Signals) ?? "SIGTERM");
  }

  list(): ProcessStatus[] {
    return [...this.processes.values()].map((p) => this.toStatus(p));
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const tracked of this.processes.values()) {
      if (tracked.running) {
        tracked.child.kill("SIGKILL");
      }
    }
    this.processes.clear();
  }

  private toStatus(tracked: TrackedProcess): ProcessStatus {
    const now = Date.now();
    return {
      id: tracked.id,
      pid: tracked.child.pid,
      running: tracked.running,
      exitCode: tracked.exitCode,
      startedAt: tracked.startedAt,
      duration: (tracked.finishedAt ?? now) - tracked.startedAt,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, tracked] of this.processes) {
      if (!tracked.running && tracked.finishedAt !== null) {
        if (now - tracked.finishedAt > CLEANUP_AGE_MS) {
          this.processes.delete(id);
        }
      }
    }
  }
}
