import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runDoctor } from "./doctor.js";
import type { DiagnosticCheck, DiagnosticResult } from "./doctor-types.js";

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function makeCheck(
  name: string,
  category: "system" | "security" | "config" | "connectivity",
  result: DiagnosticResult,
): DiagnosticCheck {
  return { name, category, run: async () => result };
}

describe("runDoctor", () => {
  it("returns exit code 0 when all checks pass", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "security", { status: "pass", message: "OK" }),
    ];
    const exitCode = await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(exitCode).toBe(0);
    expect(out).toContain("2 passed");
    expect(out).toContain("0 warnings");
    expect(out).toContain("0 failed");
  });

  it("returns exit code 0 when checks pass or warn", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "config", { status: "warn", message: "Missing", detail: "Install it" }),
    ];
    const exitCode = await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(exitCode).toBe(0);
    expect(out).toContain("1 passed");
    expect(out).toContain("1 warning");
    expect(out).toContain("0 failed");
  });

  it("returns exit code 1 when any check fails", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "system", { status: "fail", message: "Bad", detail: "Fix it" }),
    ];
    const exitCode = await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(exitCode).toBe(1);
    expect(out).toContain("1 passed");
    expect(out).toContain("1 failed");
  });

  it("displays check names and messages", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("node-version", "system", { status: "pass", message: "Node.js 22.3.0" }),
      makeCheck("vault", "config", { status: "warn", message: "Not found", detail: "Run onboard" }),
    ];
    await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(out).toContain("node-version");
    expect(out).toContain("Node.js 22.3.0");
    expect(out).toContain("vault");
    expect(out).toContain("Run onboard");
  });

  it("groups checks by category", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK" }),
      makeCheck("b", "security", { status: "pass", message: "OK" }),
      makeCheck("c", "config", { status: "pass", message: "OK" }),
      makeCheck("d", "connectivity", { status: "pass", message: "OK" }),
    ];
    await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(out).toContain("System");
    expect(out).toContain("Security");
    expect(out).toContain("Config");
    expect(out).toContain("Connectivity");
  });

  it("shows detail for warn and fail but not pass", async () => {
    const output = new PassThrough();
    const checks = [
      makeCheck("a", "system", { status: "pass", message: "OK", detail: "hidden detail" }),
      makeCheck("b", "system", { status: "warn", message: "Hmm", detail: "shown detail" }),
    ];
    await runDoctor({ output, checks });
    const out = readOutput(output);

    expect(out).not.toContain("hidden detail");
    expect(out).toContain("shown detail");
  });

  it("handles empty checks array", async () => {
    const output = new PassThrough();
    const exitCode = await runDoctor({ output, checks: [] });
    const out = readOutput(output);

    expect(exitCode).toBe(0);
    expect(out).toContain("0 passed");
  });
});
