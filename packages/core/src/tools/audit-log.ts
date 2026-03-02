import type { ToolExecutionRequest, ToolExecutionResult } from "./types.js";

export interface AuditEntry {
  timestamp: Date;
  request: ToolExecutionRequest;
  result: ToolExecutionResult;
}

export class AuditLog {
  private readonly maxEntries: number;
  private entries: AuditEntry[] = [];

  constructor(maxEntries = 100) {
    if (maxEntries < 1) {
      throw new Error("AuditLog maxEntries must be at least 1");
    }
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
