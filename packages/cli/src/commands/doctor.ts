import type { DiagnosticCheck, DiagnosticResult } from "./doctor-types.js";
import {
  nodeVersionCheck,
  platformCheck,
  architectureCheck,
  vaultExistsCheck,
  sandboxHelperCheck,
  bwrapCheck,
  socatCheck,
  ripgrepCheck,
  landlockCheck,
  seccompCheck,
  userNamespaceCheck,
  keyringCheck,
  configFileCheck,
  githubConnectivityCheck,
} from "./doctor-checks.js";

// ---------------------------------------------------------------------------
// ANSI colour helpers (disabled when NO_COLOR is set or output is not a TTY)
// ---------------------------------------------------------------------------

function supportsColor(output: NodeJS.WritableStream): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if ("isTTY" in output && (output as NodeJS.WriteStream).isTTY) return true;
  return false;
}

interface StatusStyle {
  symbol: string;
  color: (s: string) => string;
}

function statusStyles(colorEnabled: boolean): Record<DiagnosticResult["status"], StatusStyle> {
  if (!colorEnabled) {
    return {
      pass: { symbol: "[PASS]", color: (s) => s },
      warn: { symbol: "[WARN]", color: (s) => s },
      fail: { symbol: "[FAIL]", color: (s) => s },
    };
  }
  return {
    pass: { symbol: "\x1b[32m✓\x1b[0m", color: (s) => `\x1b[32m${s}\x1b[0m` },
    warn: { symbol: "\x1b[33m!\x1b[0m", color: (s) => `\x1b[33m${s}\x1b[0m` },
    fail: { symbol: "\x1b[31m✗\x1b[0m", color: (s) => `\x1b[31m${s}\x1b[0m` },
  };
}

// ---------------------------------------------------------------------------
// Category display order
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: DiagnosticCheck["category"][] = [
  "system",
  "security",
  "config",
  "connectivity",
];

const CATEGORY_LABELS: Record<DiagnosticCheck["category"], string> = {
  system: "System",
  security: "Security",
  config: "Config",
  connectivity: "Connectivity",
};

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  output: NodeJS.WritableStream;
  /** Override the default checks (useful for testing) */
  checks?: DiagnosticCheck[] | undefined;
}

/**
 * Run all diagnostic checks and print a formatted report.
 * Returns 0 if all checks pass or warn, 1 if any check fails.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const { output } = options;
  const checks = options.checks ?? createDefaultChecks();
  const colorEnabled = supportsColor(output);
  const styles = statusStyles(colorEnabled);

  function print(msg: string): void {
    output.write(msg + "\n");
  }

  print("");
  print("SafeClaw Doctor");
  print("===============");
  print("");

  // Run all checks and collect results
  const results: Array<{
    check: DiagnosticCheck;
    result: DiagnosticResult;
  }> = [];

  for (const check of checks) {
    const result = await check.run();
    results.push({ check, result });
  }

  // Group by category
  const grouped = new Map<string, typeof results>();
  for (const entry of results) {
    const cat = entry.check.category;
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push(entry);
  }

  // Print by category in fixed order
  for (const category of CATEGORY_ORDER) {
    const entries = grouped.get(category);
    if (!entries || entries.length === 0) continue;

    print(`--- ${CATEGORY_LABELS[category]} ---`);
    for (const { check, result } of entries) {
      const style = styles[result.status];
      print(`  ${style.symbol} ${check.name}: ${result.message}`);
      if (result.detail && result.status !== "pass") {
        print(`    ${result.detail}`);
      }
    }
    print("");
  }

  // Summary
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  for (const { result } of results) {
    if (result.status === "pass") passed++;
    else if (result.status === "warn") warnings++;
    else failed++;
  }

  const summary = [
    `${passed} passed`,
    `${warnings} warning${warnings === 1 ? "" : "s"}`,
    `${failed} failed`,
  ].join(", ");

  print(`Summary: ${summary}`);

  return failed > 0 ? 1 : 0;
}

/**
 * Create the default set of diagnostic checks.
 * Each check uses real system dependencies (no injection).
 */
export function createDefaultChecks(): DiagnosticCheck[] {
  return [
    // System
    nodeVersionCheck(),
    platformCheck(),
    architectureCheck(),
    // Security
    bwrapCheck(),
    socatCheck(),
    ripgrepCheck(),
    landlockCheck(),
    seccompCheck(),
    userNamespaceCheck(),
    sandboxHelperCheck(),
    // Config
    vaultExistsCheck(),
    keyringCheck(),
    configFileCheck(),
    // Connectivity
    githubConnectivityCheck(),
  ];
}
