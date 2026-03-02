import type {
  CapabilityGrant,
  ToolExecutionRequest,
  ToolExecutionResult,
  SessionMetadata,
} from "@safeclaw/core";
import type { CapabilityRegistry } from "@safeclaw/core";
import type { SessionManager } from "@safeclaw/core";

// --- AuditLog ---

export interface AuditEntry {
  timestamp: Date;
  request: ToolExecutionRequest;
  result: ToolExecutionResult;
}

export class AuditLog {
  private readonly maxEntries: number;
  private entries: AuditEntry[] = [];

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  record(request: ToolExecutionRequest, result: ToolExecutionResult): void {
    const entry: AuditEntry = {
      timestamp: new Date(),
      request,
      result,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

// --- runAudit ---

export interface AuditOptions {
  output: NodeJS.WritableStream;
  registry: CapabilityRegistry;
  sessionManager: SessionManager;
  auditLog: AuditLog;
  format?: "text" | "json";
}

export interface AuditReport {
  skills: Array<{
    id: string;
    name: string;
    version: string;
    grants: CapabilityGrant[];
  }>;
  sessions: SessionMetadata[];
  recentExecutions: AuditEntry[];
  generatedAt: Date;
}

function print(output: NodeJS.WritableStream, msg: string): void {
  output.write(msg + "\n");
}

function formatConstraints(grant: CapabilityGrant): string {
  const c = grant.constraints;
  if (!c) return grant.capability;

  if (c.paths && c.paths.length > 0) {
    return `${grant.capability} [${c.paths.join(", ")}]`;
  }
  if (c.hosts && c.hosts.length > 0) {
    return `${grant.capability} [${c.hosts.join(", ")}]`;
  }
  if (c.executables && c.executables.length > 0) {
    return `${grant.capability} [${c.executables.join(", ")}]`;
  }
  return grant.capability;
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function formatTextReport(output: NodeJS.WritableStream, report: AuditReport): void {
  print(output, "=== SafeClaw Security Audit ===");
  print(output, "");

  // Skills
  print(output, "--- Installed Skills ---");
  if (report.skills.length === 0) {
    print(output, "  (none)");
  } else {
    for (const skill of report.skills) {
      print(output, `  ${skill.id} (v${skill.version}) - ${skill.name}`);
      if (skill.grants.length > 0) {
        const formatted = skill.grants.map(formatConstraints).join(", ");
        print(output, `    Grants: ${formatted}`);
      }
    }
  }
  print(output, "");

  // Sessions
  print(output, "--- Active Sessions ---");
  if (report.sessions.length === 0) {
    print(output, "  (none)");
  } else {
    for (const session of report.sessions) {
      const peer = `${session.peer.channelId}:${session.peer.peerId}`;
      const created = session.createdAt.toISOString();
      print(output, `  ${session.id} | ${peer} | ${session.messageCount} messages | created ${created}`);
    }
  }
  print(output, "");

  // Executions
  print(output, "--- Recent Tool Executions ---");
  if (report.recentExecutions.length === 0) {
    print(output, "  (none)");
  } else {
    for (const entry of report.recentExecutions) {
      const ts = entry.timestamp.toISOString();
      const tool = entry.request.toolName;
      const skill = entry.request.skillId;
      const duration = `${entry.result.durationMs}ms`;
      const sandboxed = `sandboxed: ${entry.result.sandboxed}`;

      if (entry.result.success) {
        print(output, `  [${ts}] ${tool} (${skill}) → success (${duration}, ${sandboxed})`);
      } else {
        const err = entry.result.error ?? "unknown error";
        print(output, `  [${ts}] ${tool} (${skill}) → error: "${err}" (${duration}, ${sandboxed})`);
      }
    }
  }
  print(output, "");

  print(output, `Generated: ${report.generatedAt.toISOString()}`);
}

export function runAudit(options: AuditOptions): AuditReport {
  const { output, registry, sessionManager, auditLog, format = "text" } = options;

  const skills = registry.listSkills().map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    grants: registry.getGrants(manifest.id),
  }));

  const sessions = sessionManager.listSessions();
  const recentExecutions = auditLog.getEntries();
  const generatedAt = new Date();

  const report: AuditReport = {
    skills,
    sessions,
    recentExecutions,
    generatedAt,
  };

  if (format === "json") {
    output.write(JSON.stringify(report, dateReplacer, 2));
  } else {
    formatTextReport(output, report);
  }

  return report;
}
