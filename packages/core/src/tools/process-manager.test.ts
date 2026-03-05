import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessManager } from "./process-manager.js";

describe("ProcessManager", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
  });

  afterEach(() => {
    pm.shutdown();
  });

  it("can be instantiated", () => {
    expect(pm).toBeInstanceOf(ProcessManager);
  });

  it("list() returns empty array initially", () => {
    expect(pm.list()).toEqual([]);
  });

  it("start() spawns a process and returns an id", () => {
    const id = pm.start("echo hello");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(pm.list()).toHaveLength(1);
  });

  it("start() rejects empty command", () => {
    expect(() => pm.start("")).toThrow(/command/i);
  });

  it("start() enforces max concurrent process limit", () => {
    for (let i = 0; i < 8; i++) {
      pm.start(`sleep ${i + 10}`);
    }
    expect(() => pm.start("sleep 20")).toThrow(/concurrent/i);
  });

  it("status() returns status of a running process", () => {
    const id = pm.start("sleep 30");
    const status = pm.status(id);
    expect(status.id).toBe(id);
    expect(status.running).toBe(true);
    expect(status.exitCode).toBeNull();
    expect(status.startedAt).toBeGreaterThan(0);
    expect(status.duration).toBeGreaterThanOrEqual(0);
    expect(typeof status.pid).toBe("number");
  });

  it("status() returns status of a finished process", async () => {
    const id = pm.start("echo done");
    await new Promise((r) => setTimeout(r, 200));
    const status = pm.status(id);
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
  });

  it("status() throws for unknown id", () => {
    expect(() => pm.status("nonexistent")).toThrow(/not found/i);
  });

  it("log() returns captured output", async () => {
    const id = pm.start("echo hello && echo world");
    await new Promise((r) => setTimeout(r, 200));
    const output = pm.log(id);
    expect(output).toContain("hello");
    expect(output).toContain("world");
  });

  it("log() returns tail lines when specified", async () => {
    const id = pm.start("for i in 1 2 3 4 5; do echo line$i; done");
    await new Promise((r) => setTimeout(r, 200));
    const output = pm.log(id, { tail: 2 });
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("line4");
    expect(lines[1]).toBe("line5");
  });

  it("log() throws for unknown id", () => {
    expect(() => pm.log("nonexistent")).toThrow(/not found/i);
  });

  it("log() returns empty string when no output yet", () => {
    const id = pm.start("sleep 30");
    const output = pm.log(id);
    expect(output).toBe("");
  });

  it("kill() terminates a running process", async () => {
    const id = pm.start("sleep 60");
    await new Promise((r) => setTimeout(r, 100));
    const killed = pm.kill(id);
    expect(killed).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const status = pm.status(id);
    expect(status.running).toBe(false);
  });

  it("kill() returns false for already-finished process", async () => {
    const id = pm.start("echo quick");
    await new Promise((r) => setTimeout(r, 200));
    const killed = pm.kill(id);
    expect(killed).toBe(false);
  });

  it("kill() throws for unknown id", () => {
    expect(() => pm.kill("nonexistent")).toThrow(/not found/i);
  });

  it("kill() accepts a custom signal", async () => {
    const id = pm.start("sleep 60");
    await new Promise((r) => setTimeout(r, 100));
    const killed = pm.kill(id, "SIGKILL");
    expect(killed).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.status(id).running).toBe(false);
  });

  it("evicts oldest output when ring buffer exceeds 1MB", async () => {
    const id = pm.start("seq 1 200000");
    await new Promise((r) => setTimeout(r, 3000));
    const output = pm.log(id);
    const outputBytes = Buffer.byteLength(output, "utf-8");
    expect(outputBytes).toBeLessThanOrEqual(1024 * 1024 + 65536);
    expect(output).toContain("200000");
    expect(output).not.toContain("\n1\n");
  });

  it("cleanup removes finished processes older than threshold", async () => {
    const id = pm.start("echo done");
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.status(id).running).toBe(false);

    const internals = pm as unknown as {
      processes: Map<string, { finishedAt: number | null }>;
      cleanup: () => void;
    };
    const tracked = internals.processes.get(id)!;
    tracked.finishedAt = Date.now() - 3_600_001;

    internals.cleanup();

    expect(pm.list()).toHaveLength(0);
    expect(() => pm.status(id)).toThrow(/not found/i);
  });

  it("cleanup does not remove still-running processes", async () => {
    const id = pm.start("sleep 60");
    await new Promise((r) => setTimeout(r, 100));

    const internals = pm as unknown as { cleanup: () => void };
    internals.cleanup();

    expect(pm.list()).toHaveLength(1);
    expect(pm.status(id).running).toBe(true);
  });
});
