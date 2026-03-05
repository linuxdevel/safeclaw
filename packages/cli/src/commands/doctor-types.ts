/**
 * A single diagnostic check. Each check is a standalone function
 * that probes one aspect of the system and returns a result.
 */
export interface DiagnosticCheck {
  /** Short identifier shown in the report (e.g. "node-version") */
  name: string;
  /** Grouping category for display */
  category: "system" | "security" | "config" | "connectivity";
  /** Execute the check and return a result */
  run(): Promise<DiagnosticResult>;
}

/**
 * Result of a single diagnostic check.
 */
export interface DiagnosticResult {
  /** pass = OK, warn = non-fatal issue, fail = blocking problem */
  status: "pass" | "warn" | "fail";
  /** One-line human-readable summary */
  message: string;
  /** Optional multi-line detail (shown on warn/fail) */
  detail?: string | undefined;
}
