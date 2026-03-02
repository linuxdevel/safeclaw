import { describe, it, expect } from "vitest";
import { AuditLog } from "./audit-log.js";
import type { ToolExecutionRequest, ToolExecutionResult } from "./types.js";

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

  it("throws if maxEntries is less than 1", () => {
    expect(() => new AuditLog(0)).toThrow("AuditLog maxEntries must be at least 1");
    expect(() => new AuditLog(-5)).toThrow("AuditLog maxEntries must be at least 1");
  });
});
