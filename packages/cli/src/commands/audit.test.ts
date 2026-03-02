import { describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { AuditLog, runAudit } from "./audit.js";
import type { AuditOptions, AuditReport } from "./audit.js";
import { CapabilityRegistry, SessionManager } from "@safeclaw/core";
import type {
  SkillManifest,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "@safeclaw/core";

// --- Helpers ---

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function createSkillManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    description: "A test skill",
    signature: "sig",
    publicKey: "pubkey",
    requiredCapabilities: [],
    tools: [],
    ...overrides,
  };
}

function createRequest(overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    skillId: "builtin-tools",
    toolName: "read",
    args: {},
    ...overrides,
  };
}

function createResult(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    success: true,
    output: "ok",
    durationMs: 12,
    sandboxed: false,
    ...overrides,
  };
}

// --- AuditLog tests ---

describe("AuditLog", () => {
  it("starts empty", () => {
    const log = new AuditLog();
    expect(log.size).toBe(0);
    expect(log.getEntries()).toEqual([]);
  });

  it("records entries and returns them", () => {
    const log = new AuditLog();
    const req = createRequest();
    const res = createResult();

    log.record(req, res);

    expect(log.size).toBe(1);
    const entries = log.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.request).toBe(req);
    expect(entries[0]!.result).toBe(res);
    expect(entries[0]!.timestamp).toBeInstanceOf(Date);
  });

  it("clears all entries", () => {
    const log = new AuditLog();
    log.record(createRequest(), createResult());
    log.record(createRequest(), createResult());

    expect(log.size).toBe(2);

    log.clear();

    expect(log.size).toBe(0);
    expect(log.getEntries()).toEqual([]);
  });

  it("respects maxEntries and drops oldest on overflow", () => {
    const log = new AuditLog(3);

    for (let i = 0; i < 5; i++) {
      log.record(
        createRequest({ toolName: `tool-${i}` }),
        createResult(),
      );
    }

    expect(log.size).toBe(3);
    const entries = log.getEntries();
    expect(entries).toHaveLength(3);
    // oldest two (tool-0, tool-1) should be dropped
    expect(entries[0]!.request.toolName).toBe("tool-2");
    expect(entries[1]!.request.toolName).toBe("tool-3");
    expect(entries[2]!.request.toolName).toBe("tool-4");
  });

  it("defaults maxEntries to 100", () => {
    const log = new AuditLog();

    for (let i = 0; i < 110; i++) {
      log.record(
        createRequest({ toolName: `tool-${i}` }),
        createResult(),
      );
    }

    expect(log.size).toBe(100);
    const entries = log.getEntries();
    // first entry should be tool-10 (oldest 10 dropped)
    expect(entries[0]!.request.toolName).toBe("tool-10");
  });

  it("returns a copy of entries, not internal state", () => {
    const log = new AuditLog();
    log.record(createRequest(), createResult());

    const entries1 = log.getEntries();
    const entries2 = log.getEntries();

    expect(entries1).not.toBe(entries2);
    expect(entries1).toEqual(entries2);
  });
});

// --- runAudit tests ---

describe("runAudit", () => {
  let output: PassThrough;
  let registry: CapabilityRegistry;
  let sessionManager: SessionManager;
  let auditLog: AuditLog;

  beforeEach(() => {
    output = new PassThrough();
    registry = new CapabilityRegistry();
    sessionManager = new SessionManager();
    auditLog = new AuditLog();
  });

  function createOptions(overrides: Partial<AuditOptions> = {}): AuditOptions {
    return {
      output,
      registry,
      sessionManager,
      auditLog,
      ...overrides,
    };
  }

  it("reports empty state in text format", () => {
    const report = runAudit(createOptions());
    const out = readOutput(output);

    expect(out).toContain("=== SafeClaw Security Audit ===");
    expect(out).toContain("--- Installed Skills ---");
    expect(out).toContain("(none)");
    expect(out).toContain("--- Active Sessions ---");
    expect(out).toContain("--- Recent Tool Executions ---");
    expect(out).toContain("Generated:");

    expect(report.skills).toEqual([]);
    expect(report.sessions).toEqual([]);
    expect(report.recentExecutions).toEqual([]);
    expect(report.generatedAt).toBeInstanceOf(Date);
  });

  it("shows installed skills with grants in text format", () => {
    const manifest = createSkillManifest({
      id: "my-skill",
      version: "2.1.0",
      name: "My Skill",
    });
    registry.registerSkill(manifest);
    registry.grantCapability({
      skillId: "my-skill",
      capability: "fs:read",
      constraints: { paths: ["/tmp/*"] },
      grantedAt: new Date("2026-03-01T10:00:00Z"),
      grantedBy: "user",
    });
    registry.grantCapability({
      skillId: "my-skill",
      capability: "net:http",
      constraints: { hosts: ["example.com"] },
      grantedAt: new Date("2026-03-01T10:00:00Z"),
      grantedBy: "builtin",
    });

    const report = runAudit(createOptions());
    const out = readOutput(output);

    expect(out).toContain("my-skill (v2.1.0) - My Skill");
    expect(out).toContain("fs:read [/tmp/*]");
    expect(out).toContain("net:http [example.com]");

    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]!.id).toBe("my-skill");
    expect(report.skills[0]!.grants).toHaveLength(2);
  });

  it("shows active sessions in text format", () => {
    const session = sessionManager.create({
      channelId: "cli",
      peerId: "user1",
    });

    const report = runAudit(createOptions());
    const out = readOutput(output);

    expect(out).toContain(session.id);
    expect(out).toContain("cli:user1");

    // Sessions section specifically should not show (none)
    const sessionsSection = out.split("--- Active Sessions ---")[1]!.split("---")[0]!;
    expect(sessionsSection).not.toContain("(none)");

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]!.id).toBe(session.id);
  });

  it("shows recent tool executions in text format", () => {
    const req = createRequest({ skillId: "builtin-tools", toolName: "read" });
    const res = createResult({ success: true, durationMs: 12, sandboxed: false });
    auditLog.record(req, res);

    const report = runAudit(createOptions());
    const out = readOutput(output);

    expect(out).toContain("read (builtin-tools)");
    expect(out).toContain("success");
    expect(out).toContain("12ms");
    expect(out).toContain("sandboxed: false");

    expect(report.recentExecutions).toHaveLength(1);
  });

  it("shows error message for failed tool executions", () => {
    const req = createRequest({ skillId: "builtin-tools", toolName: "bash" });
    const res = createResult({
      success: false,
      error: "Permission denied",
      durationMs: 5,
      sandboxed: false,
    });
    auditLog.record(req, res);

    const report = runAudit(createOptions());
    const out = readOutput(output);

    expect(out).toContain("bash (builtin-tools)");
    expect(out).toContain('error: "Permission denied"');
    expect(out).toContain("5ms");

    expect(report.recentExecutions[0]!.result.success).toBe(false);
  });

  it("outputs valid JSON when format is json", () => {
    const manifest = createSkillManifest({ id: "json-skill", name: "JSON Skill", version: "1.0.0" });
    registry.registerSkill(manifest);
    registry.grantCapability({
      skillId: "json-skill",
      capability: "fs:read",
      grantedAt: new Date("2026-03-01T10:00:00Z"),
      grantedBy: "user",
    });

    sessionManager.create({ channelId: "cli", peerId: "user1" });

    auditLog.record(
      createRequest({ toolName: "read" }),
      createResult({ durationMs: 10 }),
    );

    const report = runAudit(createOptions({ format: "json" }));
    const out = readOutput(output);

    // Must be valid JSON
    const parsed = JSON.parse(out) as AuditReport;

    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]!.id).toBe("json-skill");
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.recentExecutions).toHaveLength(1);
    expect(typeof parsed.generatedAt).toBe("string");
    // Dates serialized as ISO strings
    expect(parsed.skills[0]!.grants[0]!.grantedAt).toBe("2026-03-01T10:00:00.000Z");

    // report object should have Date instances
    expect(report.generatedAt).toBeInstanceOf(Date);
  });

  it("shows (none) for empty sections in text format", () => {
    runAudit(createOptions());
    const out = readOutput(output);

    // Count occurrences of "(none)"
    const noneCount = (out.match(/\(none\)/g) ?? []).length;
    expect(noneCount).toBe(3); // skills, sessions, executions
  });

  it("returns a full audit report with all sections populated", () => {
    // Populate skills
    const manifest1 = createSkillManifest({ id: "skill-a", name: "Skill A", version: "1.0.0" });
    const manifest2 = createSkillManifest({ id: "skill-b", name: "Skill B", version: "2.0.0" });
    registry.registerSkill(manifest1);
    registry.registerSkill(manifest2);
    registry.grantCapability({
      skillId: "skill-a",
      capability: "fs:read",
      constraints: { paths: ["/home/*"] },
      grantedAt: new Date("2026-03-01T10:00:00Z"),
      grantedBy: "user",
    });
    registry.grantCapability({
      skillId: "skill-b",
      capability: "process:spawn",
      constraints: { executables: ["node", "npx"] },
      grantedAt: new Date("2026-03-01T11:00:00Z"),
      grantedBy: "builtin",
    });

    // Populate sessions
    sessionManager.create({ channelId: "cli", peerId: "user1" });
    sessionManager.create({ channelId: "web", peerId: "user2" });

    // Populate audit log
    auditLog.record(
      createRequest({ toolName: "read", skillId: "skill-a" }),
      createResult({ success: true, durationMs: 10 }),
    );
    auditLog.record(
      createRequest({ toolName: "bash", skillId: "skill-b" }),
      createResult({ success: false, error: "Denied", durationMs: 3 }),
    );

    const report = runAudit(createOptions());
    const out = readOutput(output);

    // Skills section
    expect(out).toContain("skill-a (v1.0.0) - Skill A");
    expect(out).toContain("skill-b (v2.0.0) - Skill B");
    expect(out).toContain("fs:read [/home/*]");
    expect(out).toContain("process:spawn [node, npx]");

    // Sessions section
    expect(out).toContain("cli:user1");
    expect(out).toContain("web:user2");

    // Executions section
    expect(out).toContain("read (skill-a)");
    expect(out).toContain("bash (skill-b)");

    // Report structure
    expect(report.skills).toHaveLength(2);
    expect(report.sessions).toHaveLength(2);
    expect(report.recentExecutions).toHaveLength(2);
    expect(report.generatedAt).toBeInstanceOf(Date);
  });

  it("shows grants with no constraints", () => {
    const manifest = createSkillManifest({ id: "no-constraint", name: "NC", version: "1.0.0" });
    registry.registerSkill(manifest);
    registry.grantCapability({
      skillId: "no-constraint",
      capability: "env:read",
      grantedAt: new Date("2026-03-01T10:00:00Z"),
      grantedBy: "builtin",
    });

    runAudit(createOptions());
    const out = readOutput(output);

    expect(out).toContain("env:read");
    // No brackets for unconstrained
    expect(out).not.toContain("env:read [");
  });
});
