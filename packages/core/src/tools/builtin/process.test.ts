import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { createProcessTool } from "./process.js";
import { ProcessManager } from "../process-manager.js";

describe("processTool", () => {
  let pm: ProcessManager;

  afterEach(() => {
    pm?.shutdown();
  });

  function setup() {
    pm = new ProcessManager();
    return createProcessTool(pm);
  }

  it("has correct name and metadata", () => {
    const tool = setup();
    expect(tool.name).toBe("process");
    expect(tool.description).toBeTruthy();
    expect(tool.requiredCapabilities).toEqual(["process:spawn"]);
  });

  it("rejects missing action argument", async () => {
    const tool = setup();
    await expect(tool.execute({})).rejects.toThrow(/action/i);
  });

  it("rejects unknown action", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "explode" })).rejects.toThrow(
      /unknown action/i,
    );
  });

  it("start rejects missing command", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "start" })).rejects.toThrow(
      /command/i,
    );
  });

  it("status rejects missing processId", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "status" })).rejects.toThrow(
      /processId/i,
    );
  });

  it("log rejects missing processId", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "log" })).rejects.toThrow(
      /processId/i,
    );
  });

  it("kill rejects missing processId", async () => {
    const tool = setup();
    await expect(tool.execute({ action: "kill" })).rejects.toThrow(
      /processId/i,
    );
  });

  it("start action spawns a process and returns status JSON", async () => {
    const tool = setup();
    const result = await tool.execute({ action: "start", command: "sleep 30" });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBeTruthy();
    expect(parsed.running).toBe(true);
    expect(typeof parsed.pid).toBe("number");
  });

  it("status action returns process status", async () => {
    const tool = setup();
    const startResult = JSON.parse(
      await tool.execute({ action: "start", command: "sleep 30" }),
    );
    const statusResult = JSON.parse(
      await tool.execute({ action: "status", processId: startResult.id }),
    );
    expect(statusResult.id).toBe(startResult.id);
    expect(statusResult.running).toBe(true);
  });

  it("log action returns process output", async () => {
    const tool = setup();
    const startResult = JSON.parse(
      await tool.execute({ action: "start", command: "echo test-output" }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const output = await tool.execute({
      action: "log",
      processId: startResult.id,
    });
    expect(output).toContain("test-output");
  });

  it("kill action terminates a running process", async () => {
    const tool = setup();
    const startResult = JSON.parse(
      await tool.execute({ action: "start", command: "sleep 60" }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const killResult = JSON.parse(
      await tool.execute({ action: "kill", processId: startResult.id }),
    );
    expect(killResult.killed).toBe(true);
  });

  it("list action returns all processes", async () => {
    const tool = setup();
    await tool.execute({ action: "start", command: "sleep 30" });
    await tool.execute({ action: "start", command: "sleep 31" });
    const listResult = JSON.parse(await tool.execute({ action: "list" }));
    expect(listResult).toHaveLength(2);
  });

  it("start action passes cwd option", async () => {
    const tool = setup();
    const cwd = realpathSync(tmpdir());
    const result = await tool.execute({
      action: "start",
      command: "pwd",
      cwd,
    });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    const output = await tool.execute({
      action: "log",
      processId: parsed.id,
    });
    expect(output.trim()).toBe(cwd);
  });
});
