import { describe, it, expect, vi } from "vitest";
import { CapabilityEnforcer } from "../capabilities/enforcer.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import type { CapabilityGrant } from "../capabilities/types.js";
import { ToolOrchestrator, SimpleToolRegistry } from "./orchestrator.js";
import type { ToolHandler } from "./types.js";
import { AuditLog } from "./audit-log.js";

function grantCapability(
  registry: CapabilityRegistry,
  overrides: Partial<CapabilityGrant> = {},
): void {
  registry.grantCapability({
    skillId: "test-skill",
    capability: "fs:read",
    grantedAt: new Date(),
    grantedBy: "user",
    ...overrides,
  });
}

function createHandler(overrides: Partial<ToolHandler> = {}): ToolHandler {
  return {
    name: "test-tool",
    description: "A test tool",
    requiredCapabilities: ["fs:read"],
    execute: async (_args: Record<string, unknown>) => "tool-output",
    ...overrides,
  };
}

describe("ToolOrchestrator", () => {
  it("executes tool when capability check passes", async () => {
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, { skillId: "test-skill", capability: "fs:read" });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(createHandler());

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: { path: "/some/file" },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("tool-output");
    expect(result.error).toBeUndefined();
  });

  it("returns error when tool not found in registry", async () => {
    const capRegistry = new CapabilityRegistry();
    const enforcer = new CapabilityEnforcer(capRegistry);
    const toolRegistry = new SimpleToolRegistry();

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "nonexistent-tool",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("nonexistent-tool");
    expect(result.output).toBe("");
  });

  it("returns error when capability check fails", async () => {
    const capRegistry = new CapabilityRegistry();
    // No grants — enforcer will deny
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(createHandler({ requiredCapabilities: ["net:http"] }));

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("net:http");
    expect(result.output).toBe("");
  });

  it("tracks duration in result", async () => {
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, { skillId: "test-skill", capability: "fs:read" });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        execute: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return "delayed-output";
        },
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

  it("catches handler errors and returns error result", async () => {
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, { skillId: "test-skill", capability: "fs:read" });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        execute: async () => {
          throw new Error("handler-boom");
        },
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("handler-boom");
    expect(result.output).toBe("");
  });

  it("sets sandboxed to false (v1 stub)", async () => {
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, { skillId: "test-skill", capability: "fs:read" });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(createHandler());

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.sandboxed).toBe(false);
  });

  it("checks all required capabilities before executing", async () => {
    const capRegistry = new CapabilityRegistry();
    // Only grant fs:read but not net:http
    grantCapability(capRegistry, { skillId: "test-skill", capability: "fs:read" });
    const enforcer = new CapabilityEnforcer(capRegistry);

    let executed = false;
    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        requiredCapabilities: ["fs:read", "net:http"],
        execute: async () => {
          executed = true;
          return "should-not-run";
        },
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("net:http");
    expect(executed).toBe(false);
  });
});

describe("SimpleToolRegistry", () => {
  it("registers and retrieves handlers", () => {
    const registry = new SimpleToolRegistry();
    const handler = createHandler();
    registry.register(handler);
    expect(registry.get("test-tool")).toBe(handler);
  });

  it("returns undefined for unknown tools", () => {
    const registry = new SimpleToolRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("lists all registered handlers", () => {
    const registry = new SimpleToolRegistry();
    registry.register(createHandler({ name: "tool-a" }));
    registry.register(createHandler({ name: "tool-b" }));
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((h) => h.name)).toContain("tool-a");
    expect(all.map((h) => h.name)).toContain("tool-b");
  });
});

describe("sandboxed execution", () => {
  function createSandboxedOrchestrator(
    mockSandbox: { execute: ReturnType<typeof vi.fn> },
    sandboxedTools: string[],
  ) {
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "process:spawn",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        name: "bash",
        requiredCapabilities: ["process:spawn"],
        execute: async () => "direct-output",
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, {
      sandbox: mockSandbox,
      sandboxedTools,
    });

    return { orchestrator, toolRegistry };
  }

  it("reports sandboxed: true when sandbox is provided and tool is eligible", async () => {
    const mockSandbox = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "sandboxed output",
        stderr: "",
        durationMs: 5,
        killed: false,
      }),
    };

    const { orchestrator } = createSandboxedOrchestrator(mockSandbox, ["bash"]);

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "bash",
      args: { command: "echo hello" },
    });

    expect(result.sandboxed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.output).toBe("sandboxed output");
    expect(mockSandbox.execute).toHaveBeenCalledWith("/bin/bash", [
      "-c",
      "echo hello",
    ]);
  });

  it("falls back to direct execution when no sandbox provided", async () => {
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "process:spawn",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        name: "bash",
        requiredCapabilities: ["process:spawn"],
        execute: async () => "direct-output",
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "bash",
      args: { command: "echo hello" },
    });

    expect(result.sandboxed).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toBe("direct-output");
  });

  it("falls back to direct execution for non-sandboxed tools", async () => {
    const mockSandbox = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "sandboxed output",
        stderr: "",
        durationMs: 5,
        killed: false,
      }),
    };

    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "fs:read",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        name: "test-tool",
        requiredCapabilities: ["fs:read"],
        execute: async () => "direct-output",
      }),
    );

    // Only "bash" is sandboxed, not "test-tool"
    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, {
      sandbox: mockSandbox,
      sandboxedTools: ["bash"],
    });

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.sandboxed).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toBe("direct-output");
    expect(mockSandbox.execute).not.toHaveBeenCalled();
  });

  it("returns error when sandbox execution fails", async () => {
    const mockSandbox = {
      execute: vi.fn().mockRejectedValue(new Error("sandbox-crash")),
    };

    const { orchestrator } = createSandboxedOrchestrator(mockSandbox, ["bash"]);

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "bash",
      args: { command: "echo hello" },
    });

    expect(result.success).toBe(false);
    expect(result.sandboxed).toBe(true);
    expect(result.error).toContain("sandbox-crash");
  });

  it("reports sandbox failure when exit code non-zero", async () => {
    const mockSandbox = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "command not found",
        durationMs: 3,
        killed: false,
      }),
    };

    const { orchestrator } = createSandboxedOrchestrator(mockSandbox, ["bash"]);

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "bash",
      args: { command: "bad-command" },
    });

    expect(result.success).toBe(false);
    expect(result.sandboxed).toBe(true);
    expect(result.error).toContain("command not found");
  });

  it("returns error for tool with no sandbox command mapping", async () => {
    const mockSandbox = {
      execute: vi.fn(),
    };

    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "fs:read",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        name: "unknown-tool",
        requiredCapabilities: ["fs:read"],
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, {
      sandbox: mockSandbox,
      sandboxedTools: ["unknown-tool"],
    });

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "unknown-tool",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No sandbox command mapping");
    expect(result.error).toContain("unknown-tool");
  });
});

describe("audit log recording", () => {
  it("records sandboxed execution in audit log", async () => {
    const auditLog = new AuditLog();
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "process:spawn",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        name: "bash",
        requiredCapabilities: ["process:spawn"],
        execute: async () => "direct-output",
      }),
    );

    const mockSandbox = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "sandboxed output",
        stderr: "",
        durationMs: 5,
        killed: false,
      }),
    };

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, {
      sandbox: mockSandbox,
      sandboxedTools: ["bash"],
      auditLog,
    });

    await orchestrator.execute({
      skillId: "test-skill",
      toolName: "bash",
      args: { command: "echo test" },
    });

    const entries = auditLog.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.result.sandboxed).toBe(true);
  });

  it("records direct execution in audit log", async () => {
    const auditLog = new AuditLog();
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "fs:read",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(createHandler());

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, {
      auditLog,
    });

    await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    const entries = auditLog.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.result.sandboxed).toBe(false);
    expect(entries[0]!.request.toolName).toBe("test-tool");
  });

  it("does not fail when auditLog is not provided", async () => {
    // Existing behavior — no audit log, no errors
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "fs:read",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(createHandler());

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);

    const result = await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    expect(result.success).toBe(true);
  });

  it("records failed executions in audit log", async () => {
    const auditLog = new AuditLog();
    const capRegistry = new CapabilityRegistry();
    grantCapability(capRegistry, {
      skillId: "test-skill",
      capability: "fs:read",
    });
    const enforcer = new CapabilityEnforcer(capRegistry);

    const toolRegistry = new SimpleToolRegistry();
    toolRegistry.register(
      createHandler({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );

    const orchestrator = new ToolOrchestrator(enforcer, toolRegistry, {
      auditLog,
    });

    await orchestrator.execute({
      skillId: "test-skill",
      toolName: "test-tool",
      args: {},
    });

    const entries = auditLog.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.result.success).toBe(false);
  });
});
